package main

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	wsReadTimeout  = 90 * time.Second
	wsWriteTimeout = 10 * time.Second
	joinTimeout    = 10 * time.Second

	// encMax is the longest opaque blob the relay carries, as it arrives in the
	// frame's JSON body (the two quotes included). A frame over it is refused
	// with an error code instead of being dropped in silence.
	encMax = 96<<10 + 2
)

// Per IP limits. A join window alone leaves a joined socket holding a slot for
// free, so the sockets themselves are capped per address as well. The numbers
// are generous for one person with a few tabs and tight against a loop that
// opens thousands of sockets from one host.
const (
	liveSocketsPerAddr = 24
)

// lostFrameBudget bounds how long a sender may keep spending its own relay
// budget after its last frame reached nobody: past this it is the sender that
// goes, not the guest it cannot reach. It is a variable so a test can shorten
// it.
var lostFrameBudget = 60 * time.Second

// roomBudget is how much a room may make this server relay. A frame and a byte
// count are kept per room and refilled with a token bucket, so a screen share
// fits and a flood does not.
var roomBudget = struct {
	perSecond float64
	bytes     float64
	burst     float64
}{
	perSecond: 1800,     // relayed frames per second, room wide
	bytes:     24 << 20, // relayed bytes per second, room wide
	burst:     3600,     // instant frames, for a burst of candidates or a share start
}

type server struct {
	cfg      *Config
	hub      *Hub
	log      *slog.Logger
	upgrader websocket.Upgrader

	joins   *windowLimiter
	sockets *liveSockets

	// mint is the relay credential minted only when a pair has proved itself.
	mint turnMinter

	budgetMu sync.Mutex
	// budgets is keyed by room id, not by peer: the bucket is the room's, so a
	// guest with parts of two rooms cannot spend it twice. A peer that is not
	// in a room yet spends the peer key.
	budgets map[string]*relayBudget

	// closeMu guards live, the sockets that are still open, so a shutdown can
	// close every one of them.
	closeMu sync.Mutex
	live    map[*Peer]struct{}
}

// turnMinter hands one connection a relay credential. It is a function so a
// test can see who was minted for and how often.
type turnMinter func(tag string) []iceServer

// relayBudget is the frame and byte account of one room. Rooms are short
// lived, so the account lives with the peer list and is dropped with it.
type relayBudget struct {
	tokens float64
	bytes  float64
	last   time.Time
	// lost is set on the sender that overran its own share while its last
	// frame reached nobody: the receiver is the one that cannot keep up.
	lostSince time.Time
}

func newServer(cfg *Config, hub *Hub, log *slog.Logger) *server {
	s := &server{
		cfg:     cfg,
		hub:     hub,
		log:     log,
		joins:   newWindowLimiter(time.Minute, 60),
		sockets: newLiveSockets(liveSocketsPerAddr),
		mint: func(tag string) []iceServer {
			ice, err := iceServersFor(cfg, tag)
			if err != nil {
				log.Error("could not mint relay credentials", "err", err)
			}
			return ice
		},
		budgets: make(map[string]*relayBudget),
		live:    make(map[*Peer]struct{}),
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
	if !s.sockets.acquire(addr) {
		http.Error(w, "too many connections", http.StatusTooManyRequests)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.sockets.release(addr)
		return
	}
	conn.SetReadLimit(s.cfg.MaxMsgBytes)

	p := newPeer()
	done := make(chan struct{})
	var once sync.Once
	p.onClose = func() {
		once.Do(func() {
			close(done)
			conn.Close()
			s.sockets.release(addr)
			s.forget(p)
			s.forgetLive(p)
			// The peer is out of the room, so the notice reaches the rest of
			// it. An empty room is already gone and hears nothing.
			if room := s.hub.leave(p); room != nil {
				s.hub.broadcastTo(room, mustJSON(serverMsg{T: "peer-left", From: p.id}))
				s.log.Debug("peer left")
			}
		})
	}
	defer p.close()
	go p.writeLoop(conn, done)
	// One panic in a per-peer goroutine used to take every room with it.
	defer func() {
		if r := recover(); r != nil {
			s.log.Error("panic in the socket handler", "err", r, "stack", string(debug.Stack()))
		}
	}()

	s.remember(p)
	conn.SetReadDeadline(time.Now().Add(joinTimeout))
	// Every frame the client sends, and every ping it answers, says the socket
	// is alive: the deadline is pushed forward each time. A ping is answered
	// here rather than by the default handler, because the default one does
	// not touch the deadline and a quiet tab would otherwise be cut.
	conn.SetPingHandler(func(appData string) error {
		if err := conn.SetReadDeadline(time.Now().Add(wsReadTimeout)); err != nil {
			return err
		}
		return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(wsWriteTimeout))
	})
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(wsReadTimeout))
	})

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		// A message that arrived at all proves the socket is alive: a silent
		// socket that only holds a slot dies at the deadline instead.
		if err := conn.SetReadDeadline(time.Now().Add(wsReadTimeout)); err != nil {
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
		// Any frame of a live peer is the room being used, whether or not it
		// is a ping: the idle sweep only ever takes a room nobody touches.
		room := s.hub.roomOf(p)
		s.hub.touch(room)
		var m clientMsg
		if err := json.Unmarshal(data, &m); err != nil {
			p.writeNow(conn, serverMsg{T: "error", Code: "bad-message"})
			continue
		}
		if room == nil {
			if m.T != "join" {
				p.writeNow(conn, serverMsg{T: "error", Code: "unavailable"})
				return
			}
			if !s.handleJoin(p, conn, m) {
				return
			}
			continue
		}
		if sent, ok := s.handleIce(p, conn, m); sent || !ok {
			if !ok {
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
			if !s.handleEnc(p, m) {
				return
			}
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

// tooBig tells the sender that a frame did not go out. The receiver's
// sequence counter never saw it, so a drop in silence would leave that pair out
// of step for the rest of the call; a code the sender can act on is the
// difference between one lost frame and a dead pair.
func (s *server) tooBig(p *Peer, code string) {
	p.enqueueJSON(serverMsg{T: "error", Code: code})
}

// handleIce answers a relay request. A credential is a portable UDP relay, so
// it is only minted once a pair of this connection has proved itself: the
// client sends {"t":"ice","to":<peer>} after that pair finished its handshake.
// A frame with no target means "after any proven pair", so the first proven
// frame of the connection mints it. Minting twice for one connection is
// refused, which keeps one join to one credential.
//
// It returns sent=true when the frame was an ice request (and ok=false when the
// connection must be dropped).
func (s *server) handleIce(p *Peer, conn *websocket.Conn, m clientMsg) (sent, ok bool) {
	if m.T != "ice" {
		return false, true
	}
	switch {
	case !s.cfg.turnEnabled():
		p.writeNow(conn, serverMsg{T: "error", Code: "relay-off"})
	case p.iceMinted:
		p.writeNow(conn, serverMsg{T: "error", Code: "relay-exhausted"})
	case m.To != "" && m.To != "*":
		// The target must be another member of the same room: a credential is
		// never minted for a pair that cannot exist.
		room := s.hub.roomOf(p)
		if room == nil || m.To == p.id || s.hub.peerOf(room, m.To) == nil {
			p.writeNow(conn, serverMsg{T: "error", Code: "unavailable"})
		} else {
			s.mintFor(p, conn)
		}
	default:
		s.mintFor(p, conn)
	}
	return true, true
}

// mintFor sends the relay list to one connection, once.
func (s *server) mintFor(p *Peer, conn *websocket.Conn) {
	if p.iceMinted {
		return
	}
	ice := s.mint(randomUserTag())
	if len(ice) == 0 {
		// The mark is only spent on a credential that was actually handed out:
		// setting it first locked a peer out of the relay for the life of its
		// socket whenever one mint failed, with relay-exhausted as the only
		// answer to every later ask.
		p.writeNow(conn, serverMsg{T: "error", Code: "relay-off"})
		return
	}
	p.iceMinted = true
	p.writeNow(conn, serverMsg{T: "ice", Ice: ice})
}

// handleEnc forwards one opaque blob. A target id sends it to one peer in the
// same room, an empty target or "*" sends it to every other peer. Nothing is
// decoded, counted or kept, so the relay stays blind in both directions.
//
// It returns false when the room has spent its budget and the sender must be
// closed.
func (s *server) handleEnc(p *Peer, m clientMsg) bool {
	if s.hub.roomOf(p) == nil {
		return true
	}
	// The payload is a JSON string, the one type the client sends. Anything
	// else is not a frame of ours and never goes out. The empty string is not
	// a frame either.
	if len(m.B) < 2 || len(m.B) > encMax {
		s.tooBig(p, "too-big")
		return true
	}
	if m.B[0] != '"' || m.B[len(m.B)-1] != '"' {
		s.tooBig(p, "bad-frame")
		return true
	}
	if !s.spend(p, len(m.B)) {
		// The room is over budget and this sender's own last frame reached no
		// one: close the sender, not the guests it cannot reach.
		s.log.Debug("room over relay budget, closing the sender")
		return false
	}
	msg := encFrame(p.id, m.B)
	if m.To == "" || m.To == "*" {
		// A room with nobody else in it is a page waiting for guests, not a
		// slow receiver: only a frame that missed a peer that is there counts.
		if len(s.hub.peersOf(s.hub.roomOf(p), p.id)) == 0 {
			return true
		}
		if s.hub.broadcast(p, msg) == 0 {
			s.nothingReached(p)
		} else {
			s.delivered(p)
		}
		return true
	}
	if s.hub.relay(p, m.To, msg) {
		s.delivered(p)
	} else {
		s.nothingReached(p)
	}
	return true
}

// spend charges one frame to the room and reports whether it fits. Bytes get
// their own bucket so a flood of small frames and a flood of large ones both
// hit a wall. A sender whose frames have reached nobody for lostFrameBudget is
// refused too: by then it is the sender, not its receivers, that is the
// problem.
func (s *server) spend(p *Peer, size int) bool {
	key := budgetKey(p)
	s.budgetMu.Lock()
	defer s.budgetMu.Unlock()
	b := s.budgets[key]
	if b == nil {
		b = &relayBudget{tokens: roomBudget.burst, bytes: roomBudget.bytes, last: time.Now()}
		s.budgets[key] = b
	}
	now := time.Now()
	dt := now.Sub(b.last).Seconds()
	b.last = now
	b.tokens = min(b.tokens+dt*roomBudget.perSecond, roomBudget.burst)
	b.bytes = min(b.bytes+dt*roomBudget.bytes, roomBudget.bytes)
	// A sender that reached nobody keeps its loss mark for as long as it keeps
	// failing; a frame that gets through again clears it.
	if !b.lostSince.IsZero() && now.Sub(b.lostSince) > lostFrameBudget {
		return false
	}
	if b.tokens < 1 || b.bytes < float64(size) {
		return false
	}
	b.tokens--
	b.bytes -= float64(size)
	return true
}

// delivered clears the loss mark: a sender whose frame got through again has
// a room that keeps up, whatever it was before.
func (s *server) delivered(p *Peer) {
	s.budgetMu.Lock()
	defer s.budgetMu.Unlock()
	if b := s.budgets[budgetKey(p)]; b != nil {
		b.lostSince = time.Time{}
	}
}

// nothingReached marks a frame that reached no queue. A sender that keeps
// sending while every frame goes nowhere is flooding a peer that cannot keep
// up, and it is the sender that goes once lostFrameBudget has passed.
func (s *server) nothingReached(p *Peer) {
	s.budgetMu.Lock()
	defer s.budgetMu.Unlock()
	if b := s.budgets[budgetKey(p)]; b != nil && b.lostSince.IsZero() {
		b.lostSince = time.Now()
	}
}

// forget drops the per peer accounts of a connection that is gone.
// budgetKey is the room the peer relayed in, or its own id while it has none.
// leaveRoom is set as the peer leaves, so a closing peer that already dropped
// its room still names the right bucket.
func budgetKey(p *Peer) string {
	if p.leaveRoom != "" {
		return "room:" + p.leaveRoom
	}
	if p.room != nil {
		return "room:" + p.room.id
	}
	return "peer:" + p.id
}

// forget hands the peer's bucket back only when it never joined a room: a
// joined peer's bucket is the room's, and the room must not lose its tokens
// because one guest left.
func (s *server) forget(p *Peer) {
	if p.leaveRoom != "" || p.room != nil {
		return
	}
	s.budgetMu.Lock()
	delete(s.budgets, "peer:"+p.id)
	s.budgetMu.Unlock()
}

// remember lists a live connection so a shutdown can close it.
func (s *server) remember(p *Peer) {
	s.closeMu.Lock()
	defer s.closeMu.Unlock()
	if s.live == nil {
		s.live = make(map[*Peer]struct{})
	}
	s.live[p] = struct{}{}
}

// forgetLive removes a closed connection from that list.
func (s *server) forgetLive(p *Peer) {
	s.closeMu.Lock()
	delete(s.live, p)
	s.closeMu.Unlock()
}

// closeAll closes every live socket. A shutting server hands the clients a
// close frame instead of letting their tabs notice a dead TCP connection on
// their own, and the hub stops holding rooms nobody can reach.
func (s *server) closeAll() {
	s.closeMu.Lock()
	peers := make([]*Peer, 0, len(s.live))
	for p := range s.live {
		peers = append(peers, p)
	}
	s.closeMu.Unlock()
	for _, p := range peers {
		p.close()
	}
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
		// room, over the room cap. Nothing is distinguishable.
		p.writeNow(conn, serverMsg{T: "error", Code: "unavailable"})
		return false
	}

	existing := s.hub.peersOf(room, p.id)

	// Relay credentials are not part of the join. A credential is a portable
	// UDP relay, so it is only minted once a pair of this connection has
	// proved itself and asked for one, and it stays valid for minutes, not
	// hours.

	// The join names nobody: no roster, no role, no waiting flag. A guest that
	// holds the room id learns nothing here, and the members learn of it from
	// the one opaque id in the knock below.
	p.enqueueJSON(serverMsg{T: "joined", Self: p.id})

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
