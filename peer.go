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

	// mic, cam, deaf and hand are the flags the client reported last. They
	// are only indicators for the other tiles and the member list; the media
	// itself decides the truth. The read loop of this peer writes them and
	// the join of another peer reads them, so fmu guards both.
	fmu    sync.Mutex
	mic    bool
	cam    bool
	deaf   bool
	screen bool
	hand   bool
	// handSeq is the queue number of a raised hand: the oldest raised hand of
	// the room is 1. It is 0 while the hand is down, and it never goes back
	// to an old number, so a hand that is lowered and raised again goes to
	// the back of the queue.
	handSeq int

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

// setFlags stores the flags that a state message carries and returns all four
// values as they are now. A nil pointer leaves that flag as it was. A share is
// a flag like the others, because a picture that stops must leave the stage for
// everyone at once, not only for the guest whose capture ended.
func (p *Peer) setFlags(mic, cam, deaf, screen *bool) (bool, bool, bool, bool) {
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
	if screen != nil {
		p.screen = *screen
	}
	return p.mic, p.cam, p.deaf, p.screen
}

// flags returns the last reported microphone, camera, deaf and screen flags.
func (p *Peer) flags() (bool, bool, bool, bool) {
	p.fmu.Lock()
	defer p.fmu.Unlock()
	return p.mic, p.cam, p.deaf, p.screen
}

// setHand writes the raised hand and returns it with its queue number. next is
// called, with the hand lock held, only when a hand goes up, so a room hands
// out one rising number to every raise and the queue order is the same in
// every client. No path takes the hub lock before the hand lock, so the two
// can not deadlock.
func (p *Peer) setHand(on bool, next func() int) (bool, int) {
	p.fmu.Lock()
	defer p.fmu.Unlock()
	switch {
	case on && !p.hand:
		p.hand, p.handSeq = true, next()
	case !on:
		p.hand, p.handSeq = false, 0
	}
	return p.hand, p.handSeq
}

// handState returns the raised hand and its queue number.
func (p *Peer) handState() (bool, int) {
	p.fmu.Lock()
	defer p.fmu.Unlock()
	return p.hand, p.handSeq
}

// lowerHand takes a raised hand down and reports whether there was one to
// lower, with the flags the room has to be told. The check and the change share
// one lock, so a raise that lands at the same moment is never swallowed.
func (p *Peer) lowerHand() (bool, bool, bool, bool, bool, int, bool) {
	p.fmu.Lock()
	defer p.fmu.Unlock()
	changed := p.hand
	if changed {
		p.hand, p.handSeq = false, 0
	}
	return p.mic, p.cam, p.deaf, p.screen, p.hand, p.handSeq, changed
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
	ID     string `json:"id"`
	Mic    bool   `json:"mic"`
	Cam    bool   `json:"cam"`
	Deaf   bool   `json:"deaf,omitempty"`
	Screen bool   `json:"screen,omitempty"`
	Admin  bool   `json:"admin,omitempty"`
	// Waiting is true for a guest that the room has not let in yet.
	Waiting bool `json:"waiting,omitempty"`
	// Hand is a raised hand, and HandSeq is its place in the queue.
	Hand    bool `json:"hand,omitempty"`
	HandSeq int  `json:"handSeq,omitempty"`
}

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// clientMsg is the whole client to server vocabulary: join, enc, state, mod,
// admit, leave, ping. A description and a candidate are not part of it; they
// travel inside enc.
type clientMsg struct {
	T    string `json:"t"`
	Room string `json:"room,omitempty"`
	Pass string `json:"pass,omitempty"`
	To   string `json:"to,omitempty"`

	// mic, cam, deaf and hand are pointers so "not sent" and "false" differ.
	Mic    *bool `json:"mic,omitempty"`
	Cam    *bool `json:"cam,omitempty"`
	Deaf   *bool `json:"deaf,omitempty"`
	Screen *bool `json:"screen,omitempty"`
	Hand   *bool `json:"hand,omitempty"`

	// action is the admin command: kick, mute, admin, lowerhand or
	// waitingroom.
	Action string `json:"action,omitempty"`

	// on is the value of the waitingroom command. A pointer, so "not sent"
	// and "off" differ.
	On *bool `json:"on,omitempty"`

	// b is an opaque, already encrypted payload for another peer or for the
	// whole room. The server never decodes it.
	B string `json:"b,omitempty"`
}

// serverMsg is the whole server to client vocabulary: joined, peer-joined,
// peer-left, state, admin, mod, kicked, enc, waiting-room, admitted, error,
// pong. There is no description field, so the server cannot send one.
type serverMsg struct {
	T       string      `json:"t"`
	Self    string      `json:"self,omitempty"`
	Peers   []peerInfo  `json:"peers,omitempty"`
	Peer    *peerInfo   `json:"peer,omitempty"`
	From    string      `json:"from,omitempty"`
	Mic     *bool       `json:"mic,omitempty"`
	Cam     *bool       `json:"cam,omitempty"`
	Deaf    *bool       `json:"deaf,omitempty"`
	Screen  *bool       `json:"screen,omitempty"`
	Hand    *bool       `json:"hand,omitempty"`
	HandSeq int         `json:"handSeq,omitempty"`
	Admins  []string    `json:"admins,omitempty"`
	Action  string      `json:"action,omitempty"`
	Code    string      `json:"code,omitempty"`
	Ice     []iceServer `json:"ice,omitempty"`

	// WaitingRoom is the room switch, sent with `joined` and with a
	// `waiting-room` change. Waiting is true in `joined` for a guest that
	// has to wait. A pointer for the switch, so "off" is still sent.
	WaitingRoom *bool `json:"waitingRoom,omitempty"`
	Waiting     bool  `json:"waiting,omitempty"`

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
