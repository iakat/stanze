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

	// waiting is set while the room holds this guest outside. It is read and
	// written under the hub lock, like the room itself.
	waiting bool

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
	Admin bool   `json:"admin,omitempty"`
	// Waiting is true for a guest that the room has not let in yet.
	Waiting bool `json:"waiting,omitempty"`
}

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// clientMsg is the whole client to server vocabulary: join, enc, state, mod,
// admit, leave, ping. A description and a candidate are not part of it; they
// travel inside enc. A `state` frame is an old client's clear toggle: it is
// accepted and dropped, because the toggles travel sealed now.
type clientMsg struct {
	T    string `json:"t"`
	Room string `json:"room,omitempty"`
	To   string `json:"to,omitempty"`

	// action is the admin command: kick, mute, admin or waitingroom.
	Action string `json:"action,omitempty"`

	// on is the value of the waitingroom command. A pointer, so "not sent"
	// and "off" differ.
	On *bool `json:"on,omitempty"`

	// b is an opaque, already encrypted payload for another peer or for the
	// whole room. It stays raw JSON: the relay copies it without unquoting or
	// quoting it again, and the server never reads it.
	B json.RawMessage `json:"b,omitempty"`
}

// serverMsg is the whole server to client vocabulary: joined, peer-joined,
// peer-left, admin, mod, kicked, enc, waiting-room, admitted, error, pong.
// There is no description field, so the server cannot send one, and no toggle
// field, so it cannot echo a flag either.
type serverMsg struct {
	T      string      `json:"t"`
	Self   string      `json:"self,omitempty"`
	Peers  []peerInfo  `json:"peers,omitempty"`
	Peer   *peerInfo   `json:"peer,omitempty"`
	From   string      `json:"from,omitempty"`
	Admins []string    `json:"admins,omitempty"`
	Action string      `json:"action,omitempty"`
	Code   string      `json:"code,omitempty"`
	Ice    []iceServer `json:"ice,omitempty"`

	// WaitingRoom is the room switch, sent with `joined` and with a
	// `waiting-room` change. Waiting is true in `joined` for a guest that
	// has to wait. A pointer for the switch, so "off" is still sent.
	WaitingRoom *bool `json:"waitingRoom,omitempty"`
	Waiting     bool  `json:"waiting,omitempty"`
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
// slow down connection attempts per client address.
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
