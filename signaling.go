package main

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	wsReadTimeout  = 90 * time.Second
	wsWriteTimeout = 10 * time.Second
	joinTimeout    = 10 * time.Second
)

type server struct {
	cfg      *Config
	hub      *Hub
	log      *slog.Logger
	upgrader websocket.Upgrader

	joins *windowLimiter
}

func newServer(cfg *Config, hub *Hub, log *slog.Logger) *server {
	s := &server{
		cfg:   cfg,
		hub:   hub,
		log:   log,
		joins: newWindowLimiter(time.Minute, 60),
	}
	s.upgrader = websocket.Upgrader{
		ReadBufferSize:   4096,
		WriteBufferSize:  8192,
		HandshakeTimeout: 10 * time.Second,
		CheckOrigin:      s.checkOrigin,
	}
	return s
}

// handleWSHandler is the websocket route as an http.Handler.
func (s *server) handleWSHandler() http.Handler { return http.HandlerFunc(s.handleWS) }

func (s *server) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// Non-browser clients (tests, tooling) send no Origin.
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	return s.cfg.AllowedOrigin != "" && strings.EqualFold(origin, s.cfg.AllowedOrigin)
}

// clientAddr is the key of the per address limits. Behind the proxy the right
// end of X-Forwarded-For is the address the proxy itself saw: it appends to the
// header, so every entry to the left of it is whatever the client sent and can
// name any address it likes. Taking the left end would hand a new rate limit to
// anyone who writes a different first entry on each join.
func clientAddr(r *http.Request, behindProxy bool) string {
	if behindProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			for i := len(parts) - 1; i >= 0; i-- {
				if ip := strings.TrimSpace(parts[i]); ip != "" {
					return ip
				}
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *server) handleWS(w http.ResponseWriter, r *http.Request) {
	addr := clientAddr(r, s.cfg.BehindProxy)
	if !s.joins.allow(addr) {
		http.Error(w, "too many connections", http.StatusTooManyRequests)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(s.cfg.MaxMsgBytes)

	p := newPeer()
	done := make(chan struct{})
	p.onClose = func() {
		close(done)
		conn.Close()
		// The peer is out of the room, so both messages reach the rest of it
		// and an empty room, already gone, gets no admin list.
		if room, letIn := s.hub.leaveWith(p); room != nil {
			s.hub.broadcastTo(room, mustJSON(serverMsg{T: "peer-left", From: p.id}))
			if letIn != "" {
				// The last member left and the guest that waited longest
				// takes the room; everyone is told, the guest too.
				s.hub.broadcastTo(room, mustJSON(serverMsg{T: "admitted", From: letIn, Peer: &peerInfo{ID: letIn}}))
			}
			s.hub.broadcastTo(room, mustJSON(serverMsg{T: "admin", Admins: s.hub.adminsOf(room)}))
			s.log.Debug("peer left")
		}
	}
	defer p.close()
	go p.writeLoop(conn, done)

	conn.SetReadDeadline(time.Now().Add(joinTimeout))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
	})

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		// A kick closes the socket from another goroutine; a frame already
		// read must not act on a peer that has left the room.
		select {
		case <-done:
			return
		default:
		}
		if !p.limit.allow() {
			s.log.Debug("peer exceeded message rate")
			return
		}
		var m clientMsg
		if err := json.Unmarshal(data, &m); err != nil {
			p.writeNow(conn, serverMsg{T: "error", Code: "bad-message"})
			continue
		}
		if s.hub.roomOf(p) == nil {
			if m.T != "join" {
				p.writeNow(conn, serverMsg{T: "error", Code: "unavailable"})
				return
			}
			if !s.handleJoin(p, conn, m) {
				return
			}
			continue
		}
		switch m.T {
		case "offer", "answer":
			if m.SDP == "" || m.To == "" {
				continue
			}
			s.hub.relay(p, m.To, mustJSON(serverMsg{T: m.T, From: p.id, SDP: m.SDP}))
		case "ice":
			if m.To == "" || len(m.Candidate) == 0 {
				continue
			}
			s.hub.relay(p, m.To, mustJSON(serverMsg{T: "ice", From: p.id, Candidate: m.Candidate}))
		case "state":
			// A mute, camera, deafen or raised hand toggle is a small
			// indicator for the other tiles and the member list. It carries
			// no media, and the server keeps the last value only for the
			// lifetime of the connection. The whole room gets the answer,
			// the sender too, because a raised hand needs its queue number.
			room := s.hub.roomOf(p)
			mic, cam, deaf, screen := p.setFlags(m.Mic, m.Cam, m.Deaf, m.Screen)
			if m.Hand != nil {
				p.setHand(*m.Hand, func() int { return s.hub.nextHand(room) })
			}
			hand, seq := p.handState()
			s.hub.broadcastTo(room, mustJSON(serverMsg{
				T: "state", From: p.id, Mic: &mic, Cam: &cam, Deaf: &deaf, Screen: &screen,
				Hand: &hand, HandSeq: seq,
			}))
		case "enc":
			// Opaque end-to-end payload: forwarded verbatim, never stored.
			s.handleEnc(p, m)
		case "mod":
			s.handleMod(p, m)
		case "admit":
			// Any guest inside may let a waiting guest in; the hub checks
			// both sides, and the answer goes to the whole room.
			if s.hub.admit(p, m.To) {
				s.hub.broadcastTo(s.hub.roomOf(p), mustJSON(serverMsg{T: "admitted", From: p.id, Peer: &peerInfo{ID: m.To}}))
			}
		case "leave":
			return
		case "ping":
			p.enqueueJSON(serverMsg{T: "pong"})
		}
	}
}

// handleMod runs one admin command. The server is the authority: a peer that
// is not an admin is ignored, and the target must be in the same room.
func (s *server) handleMod(p *Peer, m clientMsg) {
	room := s.hub.roomOf(p)
	if room == nil {
		return
	}
	if !s.hub.isAdmin(room, p.id) || s.hub.isWaiting(p) {
		return
	}
	if m.Action == "waitingroom" {
		// A room switch, not a command on a guest, so it has no target.
		if m.On == nil {
			return
		}
		on := *m.On
		s.hub.setWaitingRoom(room, on)
		s.hub.broadcastTo(room, mustJSON(serverMsg{T: "waiting-room", WaitingRoom: &on}))
		return
	}
	if m.To == "" || m.To == p.id {
		return
	}
	switch m.Action {
	case "admin":
		if s.hub.grantAdmin(room, m.To) {
			s.sendAdmins(room)
		}
	case "mute":
		if target := s.hub.peerOf(room, m.To); target != nil {
			target.enqueueJSON(serverMsg{T: "mod", From: p.id, Action: "mute"})
		}
	case "lowerhand":
		// The host takes a hand down, so a queue that nobody follows can be
		// cleared from the front. The room gets the new state of that guest.
		target := s.hub.peerOf(room, m.To)
		if target == nil {
			return
		}
		mic, cam, deaf, screen, hand, seq, changed := target.lowerHand()
		if !changed {
			return
		}
		s.hub.broadcastTo(room, mustJSON(serverMsg{
			T: "state", From: target.id, Mic: &mic, Cam: &cam, Deaf: &deaf, Screen: &screen,
			Hand: &hand, HandSeq: seq,
		}))
	case "kick":
		target := s.hub.peerOf(room, m.To)
		if target == nil {
			return
		}
		target.enqueueJSON(serverMsg{T: "kicked", From: p.id})
		// Give the notice a moment to leave the queue, then close the socket.
		go func() {
			time.Sleep(200 * time.Millisecond)
			target.close()
		}()
	}
}

// sendAdmins tells the whole room who holds the role now.
func (s *server) sendAdmins(room *Room) {
	s.hub.broadcastTo(room, mustJSON(serverMsg{T: "admin", Admins: s.hub.adminsOf(room)}))
}

// handleEnc forwards one opaque blob. A target id sends it to one peer in the
// same room, an empty target or "*" sends it to every other peer. Nothing is
// decoded, counted or kept, so the relay stays blind in both directions.
func (s *server) handleEnc(p *Peer, m clientMsg) {
	if s.hub.roomOf(p) == nil || m.B == "" || len(m.B) > 96<<10 {
		return
	}
	msg := mustJSON(serverMsg{T: "enc", From: p.id, B: m.B})
	if m.To == "" || m.To == "*" {
		s.hub.broadcast(p, msg)
		return
	}
	s.hub.relay(p, m.To, msg)
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"t":"error","code":"internal"}`)
	}
	return b
}

// handleJoin resolves the room and announces the new peer. It returns false if
// the connection must be dropped.
func (s *server) handleJoin(p *Peer, conn *websocket.Conn, m clientMsg) bool {
	room, err := s.hub.join(m.Room, m.Pass, p)
	if err != nil {
		// One answer for every failure: unknown room, wrong passphrase, full
		// room. Nothing is distinguishable.
		p.writeNow(conn, serverMsg{T: "error", Code: "unavailable"})
		return false
	}

	existing := s.hub.peersOf(room, p.id)
	admins := s.hub.adminsOf(room)
	isAdmin := make(map[string]bool, len(admins))
	for _, id := range admins {
		isAdmin[id] = true
	}
	peers := make([]peerInfo, 0, len(existing))
	for _, other := range existing {
		mic, cam, deaf, screen := other.flags()
		hand, seq := other.handState()
		peers = append(peers, peerInfo{
			ID: other.id, Mic: mic, Cam: cam, Deaf: deaf, Screen: screen, Admin: isAdmin[other.id],
			Waiting: s.hub.isWaiting(other), Hand: hand, HandSeq: seq,
		})
	}

	// Fresh, time limited relay credentials for this connection only.
	ice, err := iceServersFor(s.cfg)
	if err != nil {
		s.log.Error("could not mint relay credentials", "err", err)
	}

	waitingRoom := s.hub.waitingRoomOn(room)
	selfWaiting := s.hub.isWaiting(p)
	p.enqueueJSON(serverMsg{
		T:           "joined",
		Self:        p.id,
		Peers:       peers,
		Ice:         ice,
		Admins:      admins,
		WaitingRoom: &waitingRoom,
		Waiting:     selfWaiting,
	})

	ownMic, ownCam, ownDeaf, ownScreen := p.flags()
	ownHand, ownSeq := p.handState()
	joinedMsg := mustJSON(serverMsg{
		T: "peer-joined",
		Peer: &peerInfo{
			ID: p.id, Mic: ownMic, Cam: ownCam, Deaf: ownDeaf, Screen: ownScreen, Admin: isAdmin[p.id],
			Waiting: selfWaiting, Hand: ownHand, HandSeq: ownSeq,
		},
	})
	for _, other := range existing {
		other.enqueue(joinedMsg)
	}

	conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
	s.log.Debug("peer joined", "room", fingerprint(room.id), "peers", len(peers)+1)
	return true
}
