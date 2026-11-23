package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
)

var errRoomUnavailable = errors.New("room unavailable")

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
}

type Hub struct {
	mu       sync.Mutex
	rooms    map[string]*Room
	maxPeers int
	maxRooms int
}

func newHub(cfg *Config) *Hub {
	return &Hub{
		rooms:    make(map[string]*Room),
		maxPeers: cfg.MaxPeers,
		maxRooms: cfg.MaxRooms,
	}
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
		if len(h.rooms) >= h.maxRooms {
			return nil, errRoomUnavailable
		}
		room = &Room{
			id:    roomID,
			peers: make(map[string]*Peer),
		}
		h.rooms[roomID] = room
		created = true
	}
	// Full rooms fail exactly like malformed ids.
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
	p.room = room
	return room, nil
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
		p.room = nil
		return nil
	}
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
// sender's room, so a peer id from another room is simply unknown.
func (h *Hub) relay(p *Peer, to string, payload []byte) {
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
		return
	}
	target.enqueue(payload)
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

// broadcast sends one message to every other peer in the room.
func (h *Hub) broadcast(p *Peer, payload []byte) {
	room := h.roomOf(p)
	if room == nil {
		return
	}
	for _, other := range h.peersOf(room, p.id) {
		other.enqueue(payload)
	}
}
