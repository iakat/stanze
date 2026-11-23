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
		// The peer is out of the room, so the notice reaches the rest of it.
		// An empty room is already gone and hears nothing.
		if room := s.hub.leave(p); room != nil {
			s.hub.broadcastTo(room, mustJSON(serverMsg{T: "peer-left", From: p.id}))
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
		case "offer", "answer", "ice":
			// A description and a candidate belong inside the pair channel:
			// this server carries the sealed blob and never a codec or an
			// address. A client that is old enough to send one is told to
			// reload, and the peer hears nothing.
			p.writeNow(conn, serverMsg{T: "error", Code: "sealed-only"})
		case "state":
			// The microphone, camera, deafen, share and hand flags travel
			// sealed, one copy per pair, so the server keeps none of them and
			// relays none of them. A frame from a client that still sends a
			// clear toggle is dropped: the room state belongs to the guests.
			break
		case "enc":
			// Opaque end-to-end payload: forwarded verbatim, never stored.
			s.handleEnc(p, m)
		case "mod", "admit":
			// The role, the waiting room, the kick and the mute are sealed
			// notices between the guests now. A clear command is dropped: this
			// server has no way to check a role and no role to check.
			break
		case "leave":
			return
		case "ping":
			p.enqueueJSON(serverMsg{T: "pong"})
		}
	}
}

// handleEnc forwards one opaque blob. A target id sends it to one peer in the
// same room, an empty target or "*" sends it to every other peer. Nothing is
// decoded, counted or kept, so the relay stays blind in both directions.
func (s *server) handleEnc(p *Peer, m clientMsg) {
	if s.hub.roomOf(p) == nil || len(m.B) < 2 || len(m.B) > 96<<10+2 {
		return
	}
	// The payload is a JSON string, the one type the client sends. Anything
	// else is not a frame of ours and never goes out.
	if m.B[0] != '"' || m.B[len(m.B)-1] != '"' {
		return
	}
	msg := encFrame(p.id, m.B)
	if m.To == "" || m.To == "*" {
		s.hub.broadcast(p, msg)
		return
	}
	s.hub.relay(p, m.To, msg)
}

// encFrame builds the relayed frame around a payload that is already JSON, so
// the blob is never decoded and encoded again on the way through. The sender
// id is hex, minted inside this process, so it needs no escaping.
func encFrame(from string, b json.RawMessage) []byte {
	const head = `{"t":"enc","from":"`
	out := make([]byte, 0, len(head)+len(from)+len(`","b":`)+len(b)+1)
	out = append(out, head...)
	out = append(out, from...)
	out = append(out, `","b":`...)
	out = append(out, b...)
	return append(out, '}')
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
	room, err := s.hub.join(m.Room, p)
	if err != nil {
		// One answer for every failure: unknown room, malformed id, full
		// room. Nothing is distinguishable.
		p.writeNow(conn, serverMsg{T: "error", Code: "unavailable"})
		return false
	}

	existing := s.hub.peersOf(room, p.id)

	// Fresh, time limited relay credentials for this connection only.
	ice, err := iceServersFor(s.cfg)
	if err != nil {
		s.log.Error("could not mint relay credentials", "err", err)
	}

	// The join names nobody: no roster, no role, no waiting flag. A guest that
	// holds the room id learns nothing here, and the members learn of it from
	// the one opaque id in the knock below.
	p.enqueueJSON(serverMsg{T: "joined", Self: p.id, Ice: ice})

	knock := mustJSON(serverMsg{T: "peer-joined", Peer: &peerInfo{ID: p.id}})
	for _, other := range existing {
		other.enqueue(knock)
	}

	conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
	// No room id and no head count reach the log: the line says that something
	// joined, and nothing about which room or how large it is.
	s.log.Debug("peer joined")
	return true
}
