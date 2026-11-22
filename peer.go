package main

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Peer is one websocket in one room. It never outlives its connection.
type Peer struct {
	id   string
	room *Room

	// mic, cam and deaf are the flags the client reported last. They are
	// only indicators for the other tiles and the member list; the media
	// itself decides the truth. The read loop of this peer writes them and
	// the join of another peer reads them, so fmu guards both.
	fmu  sync.Mutex
	mic  bool
	cam  bool
	deaf bool

	// wmu serialises writes to the websocket. gorilla allows one concurrent
	// writer, and both the write loop and the read loop (terminal errors)
	// write on the same connection.
	wmu sync.Mutex

	send      chan []byte
	closeOnce sync.Once
	onClose   func()

	limit *tokenBucket
}

func newPeer() *Peer {
	return &Peer{
		send:  make(chan []byte, 64),
		limit: newTokenBucket(120, 60),
		mic:   true,
		cam:   true,
	}
}

// enqueue queues a message without ever blocking the sender. A peer that
// cannot keep up is disconnected instead of growing the queue.
func (p *Peer) enqueue(msg []byte) {
	if p == nil {
		return
	}
	select {
	case p.send <- msg:
	default:
		p.close()
	}
}

// setFlags stores the flags that a state message carries and returns all
// three values as they are now. A nil pointer leaves that flag as it was.
func (p *Peer) setFlags(mic, cam, deaf *bool) (bool, bool, bool) {
	p.fmu.Lock()
	defer p.fmu.Unlock()
	if mic != nil {
		p.mic = *mic
	}
	if cam != nil {
		p.cam = *cam
	}
	if deaf != nil {
		p.deaf = *deaf
	}
	return p.mic, p.cam, p.deaf
}

// flags returns the last reported microphone, camera and deaf flags.
func (p *Peer) flags() (bool, bool, bool) {
	p.fmu.Lock()
	defer p.fmu.Unlock()
	return p.mic, p.cam, p.deaf
}

// write sends one text frame. It is the only place that calls WriteMessage.
func (p *Peer) write(conn *websocket.Conn, msg []byte) error {
	p.wmu.Lock()
	defer p.wmu.Unlock()
	conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	return conn.WriteMessage(websocket.TextMessage, msg)
}

// writeNow sends one message on the connection directly. It is used for
// terminal errors, where the queued writer might lose the message on close.
func (p *Peer) writeNow(conn *websocket.Conn, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	_ = p.write(conn, b)
}

func (p *Peer) enqueueJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	p.enqueue(b)
}

func (p *Peer) close() {
	p.closeOnce.Do(func() {
		if p.onClose != nil {
			p.onClose()
		}
	})
}

type peerInfo struct {
	ID    string `json:"id"`
	Mic   bool   `json:"mic"`
	Cam   bool   `json:"cam"`
	Deaf  bool   `json:"deaf,omitempty"`
	Admin bool   `json:"admin,omitempty"`
}

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// clientMsg is the whole client to server vocabulary: join, offer, answer,
// ice-candidate, leave.
type clientMsg struct {
	T         string          `json:"t"`
	Room      string          `json:"room,omitempty"`
	Pass      string          `json:"pass,omitempty"`
	To        string          `json:"to,omitempty"`
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`

	// mic, cam and deaf are pointers so "not sent" and "false" differ.
	Mic  *bool `json:"mic,omitempty"`
	Cam  *bool `json:"cam,omitempty"`
	Deaf *bool `json:"deaf,omitempty"`

	// action is the admin command: kick, mute or admin.
	Action string `json:"action,omitempty"`

	// b is an opaque, already encrypted payload for another peer or for the
	// whole room. The server never decodes it.
	B string `json:"b,omitempty"`
}

// serverMsg is the whole server to client vocabulary: joined, peer-joined,
// peer-left, offer, answer, ice-candidate, state, admin, mod, kicked, enc,
// error, pong.
type serverMsg struct {
	T         string          `json:"t"`
	Self      string          `json:"self,omitempty"`
	Peers     []peerInfo      `json:"peers,omitempty"`
	Peer      *peerInfo       `json:"peer,omitempty"`
	From      string          `json:"from,omitempty"`
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
	Mic       *bool           `json:"mic,omitempty"`
	Cam       *bool           `json:"cam,omitempty"`
	Deaf      *bool           `json:"deaf,omitempty"`
	Admins    []string        `json:"admins,omitempty"`
	Action    string          `json:"action,omitempty"`
	Code      string          `json:"code,omitempty"`
	Ice       []iceServer     `json:"ice,omitempty"`

	// b is relayed verbatim from another peer.
	B string `json:"b,omitempty"`
}

// tokenBucket is a small per-connection message limiter.
type tokenBucket struct {
	mu     sync.Mutex
	tokens float64
	burst  float64
	rate   float64
	last   time.Time
}

func newTokenBucket(burst, perSecond float64) *tokenBucket {
	return &tokenBucket{tokens: burst, burst: burst, rate: perSecond, last: time.Now()}
}

func (b *tokenBucket) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	b.tokens += now.Sub(b.last).Seconds() * b.rate
	if b.tokens > b.burst {
		b.tokens = b.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// windowLimiter counts events per key inside a fixed window. It is used to
// slow down room creation and passphrase guessing per client address.
type windowLimiter struct {
	mu        sync.Mutex
	window    time.Duration
	limit     int
	hits      map[string]*windowEntry
	lastSweep time.Time
}

type windowEntry struct {
	count int
	start time.Time
}

func newWindowLimiter(window time.Duration, limit int) *windowLimiter {
	return &windowLimiter{window: window, limit: limit, hits: make(map[string]*windowEntry)}
}

// pruneAt is the number of keys that triggers a sweep of stale entries. A
// sweep needs no timer of its own: a map that never grows never needs one.
const pruneAt = 1024

func (l *windowLimiter) allow(key string) bool {
	if l == nil {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.hits) >= pruneAt && now.Sub(l.lastSweep) > l.window {
		l.pruneLocked(now)
		l.lastSweep = now
	}
	e, ok := l.hits[key]
	if !ok || now.Sub(e.start) > l.window {
		l.hits[key] = &windowEntry{count: 1, start: now}
		return true
	}
	if e.count >= l.limit {
		return false
	}
	e.count++
	return true
}

func (l *windowLimiter) pruneLocked(now time.Time) {
	for k, e := range l.hits {
		if now.Sub(e.start) > 2*l.window {
			delete(l.hits, k)
		}
	}
}

func (p *Peer) writeLoop(conn *websocket.Conn, done <-chan struct{}) {
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-done:
			return
		case msg := <-p.send:
			if err := p.write(conn, msg); err != nil {
				p.close()
				return
			}
		case <-ping.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
				p.close()
				return
			}
		}
	}
}
