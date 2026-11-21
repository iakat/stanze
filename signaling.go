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
		if p.room != nil {
			peers = s.hub.peersOf(p.room, p.id)
			s.hub.leave(p)
		}
		left, _ := json.Marshal(serverMsg{T: "peer-left", From: p.id})
		for _, other := range peers {
			other.enqueue(left)
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
		case "leave":
			return
		case "ping":
			p.enqueueJSON(serverMsg{T: "pong"})
		}
	}
}

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
	if m.Name = sanitizeName(m.Name); m.Name == "" {
		m.Name = "guest"
	}
	// The name is announced to the room, so it has to be on the peer before the
	// join broadcast happens.
	p.name = m.Name
	room, err := s.hub.join(m.Room, m.Pass, p)
	if err != nil {
		// One answer for every failure: unknown room, wrong passphrase, full
		// room. Nothing is distinguishable.
		writeNow(conn, serverMsg{T: "error", Code: "unavailable"})
		return false
	}

	existing := s.hub.peersOf(room, p.id)
	peers := make([]peerInfo, 0, len(existing))
	for _, other := range existing {
		peers = append(peers, peerInfo{ID: other.id, Name: other.name})
	}

	// Fresh, time limited relay credentials for this connection only.
	ice, err := iceServersFor(s.cfg)
	if err != nil {
		s.log.Error("could not mint relay credentials", "err", err)
	}

	p.enqueueJSON(serverMsg{
		T:     "joined",
		Self:  p.id,
		Peers: peers,
		Ice:   ice,
	})

	joinedMsg := mustJSON(serverMsg{
		T:    "peer-joined",
		Peer: &peerInfo{ID: p.id, Name: p.name},
	})
	for _, other := range existing {
		other.enqueue(joinedMsg)
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
