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
	name string
	room *Room

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
	ID   string `json:"id"`
	Name string `json:"name"`
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
	Name      string          `json:"name,omitempty"`
	To        string          `json:"to,omitempty"`
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
}

// serverMsg is the whole server to client vocabulary: joined, peer-joined,
// peer-left, offer, answer, ice-candidate, error, pong.
type serverMsg struct {
	T         string          `json:"t"`
	Self      string          `json:"self,omitempty"`
	Peers     []peerInfo      `json:"peers,omitempty"`
	Peer      *peerInfo       `json:"peer,omitempty"`
	From      string          `json:"from,omitempty"`
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
	Code      string          `json:"code,omitempty"`
	Ice       []iceServer     `json:"ice,omitempty"`
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
	mu     sync.Mutex
	window time.Duration
	limit  int
	hits   map[string]*windowEntry
}

type windowEntry struct {
	count int
	start time.Time
}

func newWindowLimiter(window time.Duration, limit int) *windowLimiter {
	return &windowLimiter{window: window, limit: limit, hits: make(map[string]*windowEntry)}
}

func (l *windowLimiter) allow(key string) bool {
	if l == nil {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
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

func (l *windowLimiter) prune() {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
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
			conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
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
