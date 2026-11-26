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

	// iceMinted is set once this connection was handed a relay credential. One
	// join offers one credential, so a page cannot farm the relay.
	iceMinted bool

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

// enqueue queues a message without ever blocking the sender. A peer whose
// queue is full is a receiver that cannot keep up: rather than grow the queue,
// the frame is dropped for it. Closing it would disconnect the guest that is
// merely slow while the sender that flooded it keeps its place, which is who an
// overrun hurts; a peer that drops this long is closed when its socket timeout
// fires, because its queue never drains.
func (p *Peer) enqueue(msg []byte) bool {
	if p == nil {
		return false
	}
	select {
	case p.send <- msg:
		return true
	default:
		return false
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
	ID string `json:"id"`
}

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// clientMsg is the whole client to server vocabulary: join, ice, enc, state,
// leave, ping. A description and a candidate are not part of it; they travel
// inside enc. An `ice` frame asks for a relay credential once a pair has proved
// itself, and names that pair in To. A `state` frame is an old client's clear
// toggle: it is accepted and dropped, because the toggles travel sealed now.
// There is no admin command either: the role, the waiting room, the kick and
// the mute are sealed notices between the guests, and the server can neither
// check nor forge one.
type clientMsg struct {
	T    string `json:"t"`
	Room string `json:"room,omitempty"`
	To   string `json:"to,omitempty"`

	// b is an opaque, already encrypted payload for another peer or for the
	// whole room. It stays raw JSON: the relay copies it without unquoting or
	// quoting it again, and the server never reads it.
	B json.RawMessage `json:"b,omitempty"`
}

// serverMsg is the whole server to client vocabulary: joined, ice,
// peer-joined, peer-left, enc, error, pong. There is no description field, so
// the server cannot send one, no toggle field, so it cannot echo a flag, no
// role or waiting field, so it cannot name a host or hold a guest at the door,
// and no roster field, so a one-line change cannot ship one either. The ice
// list rides its own frame and is only ever minted for a pair that proved
// itself.
type serverMsg struct {
	T    string      `json:"t"`
	Self string      `json:"self,omitempty"`
	Peer *peerInfo   `json:"peer,omitempty"`
	From string      `json:"from,omitempty"`
	Code string      `json:"code,omitempty"`
	Ice  []iceServer `json:"ice,omitempty"`
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

// liveSockets caps the number of websockets one client address holds open at
// once. The join window only counts the seconds around a join; a socket that is
// never closed holds a slot, a goroutine and a place in a room for free. The
// count goes back down when the connection closes, so the cap is a ceiling on
// what one host ties up, not a lifetime quota.
type liveSockets struct {
	mu    sync.Mutex
	max   int
	byKey map[string]int
	total int
}

func newLiveSockets(max int) *liveSockets {
	return &liveSockets{max: max, byKey: make(map[string]int)}
}

// acquire reserves one socket for key. It reports false when the address is
// already at its cap.
func (l *liveSockets) acquire(key string) bool {
	if l == nil {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.byKey[key] >= l.max {
		return false
	}
	l.byKey[key]++
	l.total++
	return true
}

// release returns one slot. A release without a matching acquire is a bug and
// is ignored rather than allowed to make the count drift below zero.
func (l *liveSockets) release(key string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if n := l.byKey[key]; n > 1 {
		l.byKey[key] = n - 1
		l.total--
	} else if n == 1 {
		delete(l.byKey, key)
		l.total--
	}
}

// count is the number of live sockets for one key, or for every key when key is
// empty. It is for tests.
func (l *liveSockets) count(key string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	if key == "" {
		return l.total
	}
	return l.byKey[key]
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
