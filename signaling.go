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
)

type server struct {
	cfg      *Config
	hub      *Hub
	log      *slog.Logger
	upgrader websocket.Upgrader

	creates *windowLimiter
	joins   *windowLimiter
}

func newServer(cfg *Config, hub *Hub, log *slog.Logger) *server {
	s := &server{
		cfg:     cfg,
		hub:     hub,
		log:     log,
		creates: newWindowLimiter(time.Minute, cfg.CreatePerMin),
		joins:   newWindowLimiter(time.Minute, 60),
	}
	s.upgrader = websocket.Upgrader{
		ReadBufferSize:   4096,
		WriteBufferSize:  8192,
		HandshakeTimeout: 10 * time.Second,
		CheckOrigin:      s.checkOrigin,
	}
	return s
}

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

func clientAddr(r *http.Request, behindProxy bool) string {
	if behindProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[0]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// handleNew creates a room. It is the only route that hands out a room id and
// it never reveals anything about existing rooms.
func (s *server) handleNew(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.creates.allow(clientAddr(r, s.cfg.BehindProxy)) {
		http.Error(w, "too many rooms", http.StatusTooManyRequests)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var in struct {
		Pass string `json:"pass"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil && err.Error() != "EOF" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if len(in.Pass) > 256 {
		http.Error(w, "passphrase too long", http.StatusBadRequest)
		return
	}
	id, err := s.hub.create(in.Pass)
	if err != nil {
		if err == errRoomLimit {
			http.Error(w, "too many rooms", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	s.log.Debug("room created", "room", fingerprint(id))
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]string{"room": id})
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
		var peers []*Peer
		room := p.room
		if room != nil {
			peers = s.hub.peersOf(room, p.id)
			s.hub.leave(p)
		}
		left, _ := json.Marshal(serverMsg{T: "peer-left", From: p.id})
		for _, other := range peers {
			other.enqueue(left)
		}
		if room != nil {
			if !p.kicked.Load() {
				s.logLineTo(room, peers, chatLine{Kind: "leave", From: p.id, Name: p.name})
			}
			adminMsg := mustJSON(serverMsg{T: "admin", Admins: s.hub.adminsOf(room)})
			for _, other := range peers {
				other.enqueue(adminMsg)
			}
		}
		if p.id != "" {
			s.log.Debug("peer left")
		}
	}
	defer p.close()
	go p.writeLoop(conn, done)

	conn.SetReadDeadline(time.Now().Add(s.cfg.JoinTimeout))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
	})

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if !p.limit.allow() {
			s.log.Debug("peer exceeded message rate")
			return
		}
		var m clientMsg
		if err := json.Unmarshal(data, &m); err != nil {
			writeNow(conn, serverMsg{T: "error", Code: "bad-message"})
			continue
		}
		if p.room == nil {
			if m.T != "join" {
				writeNow(conn, serverMsg{T: "error", Code: "unavailable"})
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
		case "keyframe":
			// A receiver without a picture asks the sender for a key frame.
			// The message carries no media and no room content.
			if m.To == "" {
				continue
			}
			s.hub.relay(p, m.To, mustJSON(serverMsg{T: "keyframe", From: p.id}))
		case "state":
			// A mute or camera toggle is a small indicator for the other
			// tiles. It carries no media, and the server keeps the last value
			// only for the lifetime of the connection.
			if m.Mic != nil {
				p.mic = *m.Mic
			}
			if m.Cam != nil {
				p.cam = *m.Cam
			}
			mic, cam := p.mic, p.cam
			s.hub.broadcast(p, mustJSON(serverMsg{
				T: "state", From: p.id, Mic: &mic, Cam: &cam,
			}))
		case "enc":
			// Opaque end-to-end payload: forwarded verbatim, never stored.
			s.handleEnc(p, m)
		case "mod":
			s.handleMod(p, m)
		case "chat":
			s.handleChat(p, m)
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
	room := p.room
	if room == nil || m.To == "" || m.To == p.id {
		return
	}
	if !s.hub.isAdmin(room, p.id) {
		return
	}
	switch m.Action {
	case "admin":
		if s.hub.grantAdmin(room, m.To) {
			s.sendAdmins(room)
			if target := s.hub.peerOf(room, m.To); target != nil {
				s.logLine(room, chatLine{Kind: "admin", From: p.id, Name: p.name, Text: target.name})
			}
		}
	case "mute":
		if target := s.hub.peerOf(room, m.To); target != nil {
			target.enqueueJSON(serverMsg{T: "mod", From: p.id, Action: "mute"})
			s.logLine(room, chatLine{Kind: "mute", From: p.id, Name: target.name, Text: p.name})
		}
	case "kick":
		target := s.hub.peerOf(room, m.To)
		if target == nil {
			return
		}
		target.kicked.Store(true)
		target.enqueueJSON(serverMsg{T: "kicked", From: p.id})
		s.logLine(room, chatLine{Kind: "kick", From: p.id, Name: target.name, Text: p.name})
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

// logLine adds one line to the room log and sends it to everyone in the room.
func (s *server) logLine(room *Room, line chatLine) {
	// In blind relay mode the server has no plaintext to log: names, chat and
	// room events stay inside the encrypted client.
	if s.cfg.E2E {
		return
	}
	line.TS = time.Now().UnixMilli()
	s.hub.addChat(room, line)
	s.hub.broadcastTo(room, mustJSON(serverMsg{
		T: "chat", Kind: line.Kind, From: line.From, Name: line.Name,
		Text: line.Text, TS: line.TS,
	}))
}

// logLineTo adds one line to the room log and sends it to a fixed peer list.
// It is used when the sender has just left and the room broadcast no longer
// reaches them.
func (s *server) logLineTo(room *Room, peers []*Peer, line chatLine) {
	if s.cfg.E2E {
		return
	}
	line.TS = time.Now().UnixMilli()
	s.hub.addChat(room, line)
	msg := mustJSON(serverMsg{
		T: "chat", Kind: line.Kind, From: line.From, Name: line.Name,
		Text: line.Text, TS: line.TS,
	})
	for _, other := range peers {
		other.enqueue(msg)
	}
}

// handleChat relays one text line. The text is cut to a sane length and control
// characters are dropped, so a line can not break the layout of another client.
func (s *server) handleChat(p *Peer, m clientMsg) {
	room := p.room
	if room == nil || s.cfg.E2E {
		// There is no plaintext chat path in blind relay mode.
		return
	}
	text := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, m.Text)
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if runes := []rune(text); len(runes) > chatTextMax {
		text = string(runes[:chatTextMax])
	}
	s.logLine(room, chatLine{Kind: "text", From: p.id, Name: p.name, Text: text})
}

// handleEnc forwards one opaque blob. A target id sends it to one peer in the
// same room, an empty target or "*" sends it to every other peer. Nothing is
// decoded, counted or kept. The blob is blind in both directions, so a plain
// server forwards it as well: a sealed room is a choice of the client, not a
// flag of the process.
func (s *server) handleEnc(p *Peer, m clientMsg) {
	if p.room == nil || m.B == "" || len(m.B) > 96<<10 {
		return
	}
	msg := mustJSON(serverMsg{T: "enc", From: p.id, B: m.B})
	if m.To == "" || m.To == "*" {
		s.hub.broadcast(p, msg)
		return
	}
	s.hub.relay(p, m.To, msg)
}

// chatTextMax is the longest accepted chat line, in runes.
const chatTextMax = 500

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"t":"error","code":"internal"}`)
	}
	return b
}

// writeNow sends one message on the connection directly. It is used for
// terminal errors, where the queued writer might lose the message on close.
func writeNow(conn *websocket.Conn, v any) {
	conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	conn.WriteMessage(websocket.TextMessage, b)
}

// handleJoin resolves the room and announces the new peer. It returns false if
// the connection must be dropped.
func (s *server) handleJoin(p *Peer, conn *websocket.Conn, m clientMsg) bool {
	if s.cfg.E2E {
		// The server has no business knowing a peer name. Every peer is
		// announced under the same placeholder; real names travel in the
		// encrypted channel.
		m.Name = "guest"
	}
	if m.Name = sanitizeName(m.Name); m.Name == "" {
		m.Name = "guest"
	}
	// The name is announced to the room, so it has to be on the peer before the
	// join broadcast happens.
	p.name = m.Name
	p.sealed = m.Sealed
	room, err := s.hub.join(m.Room, m.Pass, p)
	if err != nil {
		// One answer for every failure: unknown room, wrong passphrase, full
		// room. Nothing is distinguishable.
		writeNow(conn, serverMsg{T: "error", Code: "unavailable"})
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
		peers = append(peers, peerInfo{
			ID: other.id, Name: other.name, Mic: other.mic, Cam: other.cam,
			Admin: isAdmin[other.id], Sealed: other.sealed,
		})
	}

	// The join itself is the first line of the room log, so the peer that just
	// arrived finds it in the history it receives.
	line := chatLine{Kind: "join", From: p.id, Name: p.name, TS: time.Now().UnixMilli()}
	var history []chatLine
	if !s.cfg.E2E {
		history = s.hub.addChat(room, line)
	}

	// Fresh, time limited relay credentials for this connection only.
	ice, err := iceServersFor(s.cfg)
	if err != nil {
		s.log.Error("could not mint relay credentials", "err", err)
	}

	p.enqueueJSON(serverMsg{
		T:      "joined",
		Self:   p.id,
		Peers:  peers,
		Ice:    ice,
		Admins: admins,
		Chat:   history,
	})

	joinedMsg := mustJSON(serverMsg{
		T:    "peer-joined",
		Peer: &peerInfo{ID: p.id, Name: p.name, Mic: p.mic, Cam: p.cam, Admin: isAdmin[p.id], Sealed: p.sealed},
	})
	lineMsg := mustJSON(serverMsg{
		T: "chat", Kind: line.Kind, From: line.From, Name: line.Name, TS: line.TS,
	})
	for _, other := range existing {
		other.enqueue(joinedMsg)
		if !s.cfg.E2E {
			other.enqueue(lineMsg)
		}
	}

	conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
	s.log.Debug("peer joined", "room", fingerprint(room.id), "peers", len(peers)+1)
	return true
}

func sanitizeName(name string) string {
	var b strings.Builder
	n := 0
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			continue
		}
		if n >= 32 {
			break
		}
		b.WriteRune(r)
		n++
	}
	return strings.TrimSpace(b.String())
}
