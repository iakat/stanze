package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"
)

var errRoomUnavailable = errors.New("room unavailable")

// roomHeadroom is the fraction of maxRooms at which a new room is refused. A
// room that already exists keeps admitting: a call in progress never loses a
// guest to a cap, while the map can no longer be filled by an empty knock. The
// last twenty percent stays a working margin for calls that are already up.
var roomHeadroom = struct{ num, den int }{8, 10}

// roomIdleTimeout is how long a room may stay open with no sign of life from
// its guests before it is dropped and its peers are disconnected. Every frame a
// guest sends counts, and so does every keepalive the socket answers: the
// server pings every 25 s and the browser's pong touches the room, so a call
// that is up but carries no application frame—which is every call once the
// sealed channels are open—still proves itself well inside this window. What
// this catches is a room whose sockets are gone without a close frame. It is a
// variable so a test can shorten it.
var roomIdleTimeout = 5 * time.Minute

// roomSweepEvery is how often the sweep looks for idle rooms. Sweeping on a
// timer rather than at join time keeps the cost off the join path.
const roomSweepEvery = 30 * time.Second

// roomNameMax is the longest accepted room name. Custom names are allowed on
// purpose (a room can be named after a topic), so a name is only checked for
// shape and never treated as a secret.
const roomNameMax = 64

// validRoomName reports whether a custom room name is acceptable. Lowercase
// letters, digits, dot, dash and underscore keep the name safe inside a URL
// fragment and inside a log line.
func validRoomName(id string) bool {
	if len(id) == 0 || len(id) > roomNameMax {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_' {
			continue
		}
		return false
	}
	return true
}

func newPeerID() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// freePeerID mints an id that this room does not already hold. Six bytes make a
// collision rare, and a retry is cheaper than a longer id.
func (r *Room) freePeerID() (string, error) {
	for i := 0; i < 4; i++ {
		id, err := newPeerID()
		if err != nil {
			return "", err
		}
		if r.peers[id] == nil {
			return id, nil
		}
	}
	return "", errRoomUnavailable
}

// Room lives only in memory and is dropped with its last peer. It holds no
// room secret: the passphrase stays in the browser and becomes a SPAKE2
// scalar there, so the server has nothing to compare and nothing to leak. It
// holds no role list and no waiting flag either: both are sealed commits that
// travel between the guests, and the server can neither read nor forge one.
type Room struct {
	id    string
	peers map[string]*Peer
	// lastSeen is when this room last carried a frame. It is written under
	// the hub lock, from any peer of the room, and read by the sweep.
	lastSeen time.Time
	// started is when the room was made, so a room whose peers never send a
	// frame still ages out.
	started time.Time
}

type Hub struct {
	mu        sync.Mutex
	rooms     map[string]*Room
	maxPeers  int
	maxRooms  int
	lastWarn  time.Time // when the headroom warning last reached the log
	warnEvery time.Duration
	log       func(roomCount, cap int) // nil in tests; the server installs one
	// sweepWg counts the sweeper goroutine, so a shutdown waits for it before
	// it closes the sockets.
	sweepWg sync.WaitGroup
}

// waitSweeper blocks until a stopped sweeper has returned.
func (h *Hub) waitSweeper() { h.sweepWg.Wait() }

func newHub(cfg *Config) *Hub {
	now := time.Now()
	return &Hub{
		rooms:     make(map[string]*Room),
		maxPeers:  cfg.MaxPeers,
		maxRooms:  cfg.MaxRooms,
		warnEvery: time.Minute,
		lastWarn:  now.Add(-time.Minute),
	}
}

// roomLimit is the number of rooms above which a new room is refused. It is
// rounded up, because a fraction of a room would refuse the second one on a
// tiny limit as surely as it refuses the third.
func (h *Hub) roomLimit() int {
	products := h.maxRooms * roomHeadroom.num
	return (products + roomHeadroom.den - 1) / roomHeadroom.den
}

// join attaches a peer to a room. A room that does not exist yet is created by
// the first join. The passphrase is not a server matter: a wrong one fails the
// sealed handshake between the guests and costs them one attempt, while this
// function only sees a room id, so a malformed id and a full room still fail
// with the same error and nothing else is distinguishable.
func (h *Hub) join(roomID string, p *Peer) (*Room, error) {
	roomID = strings.ToLower(strings.TrimSpace(roomID))
	if !validRoomName(roomID) {
		return nil, errRoomUnavailable
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	room, ok := h.rooms[roomID]
	created := false
	if !ok {
		// A new room costs a slot; an existing one only costs a seat. The
		// headroom keeps a flood of one-socket rooms from evicting the calls
		// that are already inside the cap.
		if len(h.rooms) >= h.roomLimit() {
			h.warnLocked()
			return nil, errRoomUnavailable
		}
		now := time.Now()
		room = &Room{
			id:       roomID,
			peers:    make(map[string]*Peer),
			lastSeen: now,
			started:  now,
		}
		h.rooms[roomID] = room
		created = true
	}
	// Full rooms fail exactly like malformed ids. An unset cap is an empty
	// room: no seat fits, and the join fails rather than trivially passing.
	if len(room.peers) >= h.maxPeers {
		if created {
			delete(h.rooms, roomID)
		}
		return nil, errRoomUnavailable
	}
	if p.id == "" {
		id, err := room.freePeerID()
		if err != nil {
			// A room made by this call and left empty is not a room.
			if created {
				delete(h.rooms, roomID)
			}
			return nil, errRoomUnavailable
		}
		p.id = id
	}
	room.peers[p.id] = p
	room.lastSeen = time.Now()
	p.room = room
	// A peer that relaid in another room names that one only until it is
	// seated again: the relay account is the room's, so a guest carried
	// through a door has to spend the new room's tokens, not the old one's.
	p.leaveRoom = ""
	return room, nil
}

// warnLocked logs that the headroom threshold was reached. The line names a
// count and a cap and nothing else: no room id, no address, no peer.
func (h *Hub) warnLocked() {
	if h.log == nil {
		return
	}
	now := time.Now()
	if now.Sub(h.lastWarn) < h.warnEvery {
		return
	}
	h.lastWarn = now
	h.log(len(h.rooms), h.roomLimit())
}

// touch records that a room carried a frame, so the sweep does not take a
// quiet-but-live call. It is called from the read path, so it does not take the
// hub lock for a room that has nothing to update.
func (h *Hub) touch(room *Room) {
	if room == nil {
		return
	}
	h.mu.Lock()
	room.lastSeen = time.Now()
	h.mu.Unlock()
}

// sweepIdle drops every room that has carried no frame for roomIdleTimeout and
// closes its peers, which tells the guests and frees their sockets. It returns
// the number of rooms dropped. A room that leaves one bad connection behind
// cannot hold a slot for good this way.
func (h *Hub) sweepIdle(now time.Time) int {
	// stale is a snapshot of the peers of every dropped room, taken under the
	// lock. The live map cannot be walked after the unlock: a leave on another
	// goroutine deletes from it, and reading it there is a race the race
	// detector reports as a map read during a write.
	var stale [][]*Peer
	h.mu.Lock()
	for id, room := range h.rooms {
		if now.Sub(room.lastSeen) < roomIdleTimeout {
			continue
		}
		delete(h.rooms, id)
		gone := make([]*Peer, 0, len(room.peers))
		for _, p := range room.peers {
			p.room = nil
			gone = append(gone, p)
			// The peer last relaid in this room, so the relay account it
			// marked is this room's: a swept peer has to name it to take its
			// own loss mark out of it on close, as a peer that left does.
			p.leaveRoom = room.id
		}
		stale = append(stale, gone)
	}
	h.mu.Unlock()
	// Close outside the lock: a close runs the onClose hook, which leaves the
	// hub again.
	for _, gone := range stale {
		for _, p := range gone {
			p.close()
		}
	}
	return len(stale)
}

// runSweeper sweeps until stop is closed.
func (h *Hub) runSweeper(stop <-chan struct{}) {
	h.sweepWg.Add(1)
	defer h.sweepWg.Done()
	t := time.NewTicker(roomSweepEvery)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			h.sweepIdle(now)
		}
	}
}

// leave removes the peer from its room and returns that room, or nil when the
// peer held the last place in it, so the caller can address the rest of it.
func (h *Hub) leave(p *Peer) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := p.room
	if room == nil {
		return nil
	}
	delete(room.peers, p.id)
	if len(room.peers) == 0 {
		// The last peer takes the room with it, and a later join starts
		// from nothing.
		if h.rooms[room.id] == room {
			delete(h.rooms, room.id)
		}
		p.leaveRoom = room.id
		p.room = nil
		return nil
	}
	p.leaveRoom = room.id
	p.room = nil
	return room
}

// roomOf reads the room of a peer under the hub lock.
func (h *Hub) roomOf(p *Peer) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	return p.room
}

// peersOf returns a copy of the peer list of a room, excluding skip. A room that
// is already gone answers with nothing: a leave on another goroutine can clear
// the room of a peer while its own read loop is still on one message.
func (h *Hub) peersOf(room *Room, skip string) []*Peer {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room == nil {
		return nil
	}
	out := make([]*Peer, 0, len(room.peers))
	for id, p := range room.peers {
		if id != skip {
			out = append(out, p)
		}
	}
	return out
}

// relay forwards a message to a peer in the same room. Lookups never leave the
// sender's room, so a peer id from another room is simply unknown. It reports
// whether the frame reached the queue of its target.
func (h *Hub) relay(p *Peer, to string, payload []byte) bool {
	h.mu.Lock()
	room := p.room
	var target *Peer
	if room != nil {
		if t, ok := room.peers[to]; ok && to != p.id {
			target = t
		}
	}
	h.mu.Unlock()
	if target == nil {
		return false
	}
	return target.enqueue(payload)
}

// peerOf looks one peer up inside a room.
func (h *Hub) peerOf(room *Room, id string) *Peer {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room == nil {
		return nil
	}
	return room.peers[id]
}

// broadcastTo sends one message to every peer in the room, the admin too.
func (h *Hub) broadcastTo(room *Room, payload []byte) {
	for _, p := range h.peersOf(room, "") {
		p.enqueue(payload)
	}
}

// broadcast sends one message to every other peer in the room. It reports how
// many peers took it.
func (h *Hub) broadcast(p *Peer, payload []byte) int {
	room := h.roomOf(p)
	if room == nil {
		return 0
	}
	n := 0
	for _, other := range h.peersOf(room, p.id) {
		if other.enqueue(payload) {
			n++
		}
	}
	return n
}
