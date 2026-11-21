package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
)

var errRoomUnavailable = errors.New("room unavailable")

// roomIDBytes is also the amount of entropy per room id: 128 bits, which is
// unguessable by brute force, so rooms need no directory.
const roomIDBytes = 16

// roomIDLen is the length of a base32 encoded room id.
const roomIDLen = (roomIDBytes*8 + 4) / 5

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

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

func newRoomID() (string, error) {
	b := make([]byte, roomIDBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return strings.ToLower(b32.EncodeToString(b)), nil
}

func newPeerID() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// passHash is a PBKDF2-HMAC-SHA256 digest of a room passphrase with a random
// per-room salt. Only the digest is kept, and only in memory.
type passHash struct {
	salt []byte
	hash []byte
}

const passIterations = 150000

func hashPassphrase(pass string) (*passHash, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	return &passHash{salt: salt, hash: pbkdf2SHA256([]byte(pass), salt, passIterations, 32)}, nil
}

func (p *passHash) matches(pass string) bool {
	got := pbkdf2SHA256([]byte(pass), p.salt, passIterations, len(p.hash))
	return subtle.ConstantTimeCompare(got, p.hash) == 1
}

func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	prf := hmac.New(sha256.New, password)
	block := make([]byte, 0, len(salt)+4)
	block = append(block, salt...)
	block = append(block, 0, 0, 0, 1)
	prf.Write(block)
	u := prf.Sum(nil)
	out := make([]byte, len(u))
	copy(out, u)
	for i := 1; i < iter; i++ {
		prf.Reset()
		prf.Write(u)
		u = prf.Sum(u[:0])
		for j := range out {
			out[j] ^= u[j]
		}
		if keyLen < len(out) {
			return out[:keyLen]
		}
	}
	return out[:keyLen]
}

// Room lives only in memory and is dropped with its last peer.
type Room struct {
	id    string
	pass  *passHash
	peers map[string]*Peer
	// never set again: the last leave drops the room, so only a room that
	// was created ahead of the first join waits in the map while empty.
	// admins are the peers that may mute, remove or promote others. The first
	// peer in the room gets the role, and a room can have several admins.
	admins map[string]bool
	// order keeps the join order, so a new admin is the oldest peer.
	order []string
}

type Hub struct {
	mu           sync.Mutex
	rooms        map[string]*Room
	maxPeers     int
	maxRooms     int
	rnd          func() (string, error)
	hashSem      chan struct{}
}

// hashSlot bounds how many passphrase hashes run at once, so join attempts
// cannot turn into a CPU amplifier.
func (h *Hub) hashSlot() func() {
	h.hashSem <- struct{}{}
	return func() { <-h.hashSem }
}

func newHub(cfg *Config) *Hub {
	return &Hub{
		rooms:        make(map[string]*Room),
		maxPeers:     cfg.MaxPeers,
		maxRooms:     cfg.MaxRooms,
		rnd:          newRoomID,
		hashSem:      make(chan struct{}, 4),
	}
}

// join attaches a peer to a room. A room that does not exist yet is created by
// the first join, and the passphrase sent with that join becomes the room
// passphrase. Every other failure mode returns the same error so a client
// cannot tell a malformed id from a wrong passphrase or a full room.
func (h *Hub) join(roomID, passphrase string, p *Peer) (*Room, error) {
	roomID = strings.ToLower(strings.TrimSpace(roomID))
	if !validRoomName(roomID) {
		return nil, errRoomUnavailable
	}

	// Look up the passphrase digest without holding the lock: hashing is slow
	// on purpose and must not stall every other room.
	h.mu.Lock()
	room, ok := h.rooms[roomID]
	var hash *passHash
	if ok {
		hash = room.pass
	}
	h.mu.Unlock()

	release := h.hashSlot()
	var pass *passHash
	passOK := false
	if ok {
		passOK = hash == nil && passphrase == "" ||
			hash != nil && hash.matches(passphrase)
	} else if passphrase != "" {
		var err error
		pass, err = hashPassphrase(passphrase)
		if err != nil {
			release()
			return nil, errRoomUnavailable
		}
	}
	release()

	h.mu.Lock()
	defer h.mu.Unlock()

	if room, ok = h.rooms[roomID]; ok {
		if !passOK || room.pass != hash {
			return nil, errRoomUnavailable
		}
	} else {
		if len(h.rooms) >= h.maxRooms {
			return nil, errRoomUnavailable
		}
		room = &Room{
			id:     roomID,
			pass:   pass,
			peers:  make(map[string]*Peer),
			admins: make(map[string]bool),
		}
		h.rooms[roomID] = room
	}
	// Full rooms fail exactly like malformed ids.
	if len(room.peers) >= h.maxPeers {
		return nil, errRoomUnavailable
	}
	if p.id == "" {
		id, err := newPeerID()
		if err != nil {
			return nil, errRoomUnavailable
		}
		p.id = id
	}
	room.peers[p.id] = p
	room.order = append(room.order, p.id)
	p.room = room
	if len(room.admins) == 0 {
		room.admins[p.id] = true
	}
	return room, nil
}

func (h *Hub) leave(p *Peer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := p.room
	if room == nil {
		return
	}
	delete(room.peers, p.id)
	for i, id := range room.order {
		if id == p.id {
			room.order = append(room.order[:i], room.order[i+1:]...)
			break
		}
	}
	delete(room.admins, p.id)
	if len(room.peers) == 0 {
		// The last peer takes the room with it. The passphrase digest dies
		// here, so a later join starts from nothing.
		if h.rooms[room.id] == room {
			delete(h.rooms, room.id)
		}
		p.room = nil
		return
	}
	if len(room.admins) == 0 {
		for _, id := range room.order {
			if _, ok := room.peers[id]; ok {
				room.admins[id] = true
				break
			}
		}
	}
	p.room = nil
}

// peersOf returns a copy of the peer list of a room, excluding skip.
func (h *Hub) peersOf(room *Room, skip string) []*Peer {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]*Peer, 0, len(room.peers))
	for id, p := range room.peers {
		if id == skip {
			continue
		}
		out = append(out, p)
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

// adminsOf returns the current admin ids of a room, oldest first.
func (h *Hub) adminsOf(room *Room) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room == nil {
		return nil
	}
	out := make([]string, 0, len(room.admins))
	for _, id := range room.order {
		if room.admins[id] {
			out = append(out, id)
		}
	}
	return out
}

// isAdmin reports whether one peer holds the admin role.
func (h *Hub) isAdmin(room *Room, id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room == nil {
		return false
	}
	return room.admins[id]
}

// grantAdmin gives the role to another peer of the same room. The role is only
// added: a room can have more than one admin.
func (h *Hub) grantAdmin(room *Room, id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room == nil {
		return false
	}
	if _, ok := room.peers[id]; !ok {
		return false
	}
	room.admins[id] = true
	return true
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
	for _, other := range h.peersOf(p.room, p.id) {
		other.enqueue(payload)
	}
}

// stats returns aggregate numbers only; no room identity can leave this call.
func (h *Hub) stats() (rooms, peers int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.rooms {
		peers += len(r.peers)
	}
	return len(h.rooms), peers
}

// fingerprint is the only form of a room id that ever reaches a log line.
func fingerprint(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:4])
}
