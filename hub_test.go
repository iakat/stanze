package main

import "testing"

func newTestHub(t *testing.T) *Hub {
	t.Helper()
	return newHub(&Config{MaxPeers: 8, MaxRooms: 50})
}

func joinPeer(t *testing.T, h *Hub, roomID, pass string) (*Peer, *Room) {
	t.Helper()
	p := newPeer()
	room, err := h.join(roomID, pass, p)
	if err != nil {
		t.Fatalf("join %q: %v", roomID, err)
	}
	return p, room
}

func roomCount(h *Hub) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.rooms)
}

func roomInMap(h *Hub, id string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.rooms[id]
}

// The last leave must drop the room in the same locked section, not later.
func TestLastLeaveDropsRoomAtOnce(t *testing.T) {
	h := newTestHub(t)

	p, room := joinPeer(t, h, "abc", "")
	if got := roomCount(h); got != 1 {
		t.Fatalf("rooms after join = %d, want 1", got)
	}
	if room.id != "abc" {
		t.Fatalf("room id = %q, want %q", room.id, "abc")
	}

	h.leave(p)

	if got := roomCount(h); got != 0 {
		t.Fatalf("rooms after last leave = %d, want 0", got)
	}
	if roomInMap(h, "abc") != nil {
		t.Fatal("room still in the map after its last peer left")
	}
	if p.room != nil {
		t.Fatal("peer still points at the dropped room")
	}
}

// One of two peers leaving keeps the room and the other peer.
func TestRoomSurvivesOneLeaveOfTwo(t *testing.T) {
	h := newTestHub(t)

	a, _ := joinPeer(t, h, "abc", "")
	b, _ := joinPeer(t, h, "abc", "")

	h.leave(a)

	room := roomInMap(h, "abc")
	if room == nil {
		t.Fatal("room dropped while a peer was still in it")
	}
	if len(room.peers) != 1 || room.peers[b.id] == nil {
		t.Fatalf("peers after one leave = %d, want only b", len(room.peers))
	}
	if got := roomCount(h); got != 1 {
		t.Fatalf("rooms after one leave = %d, want 1", got)
	}
}

// The oldest remaining peer inherits the role when the last admin leaves, and
// that path still runs for a room that keeps peers.
func TestAdminReassignedWhenAdminLeaves(t *testing.T) {
	h := newTestHub(t)

	a, room := joinPeer(t, h, "abc", "")
	b, _ := joinPeer(t, h, "abc", "")
	if admins := h.adminsOf(room); len(admins) != 1 || admins[0] != a.id {
		t.Fatalf("admins after two joins = %v, want [%s]", admins, a.id)
	}

	h.leave(a)

	admins := h.adminsOf(room)
	if len(admins) != 1 || admins[0] != b.id {
		t.Fatalf("admins after the admin left = %v, want [%s]", admins, b.id)
	}
	if !h.isAdmin(room, b.id) {
		t.Fatal("oldest remaining peer did not become admin")
	}
}

// Everything the room held dies with it: a later join starts from nothing, so
// no state and a passphrase the newcomer picks.
func TestRejoinAfterDropStartsFresh(t *testing.T) {
	h := newTestHub(t)

	a, room := joinPeer(t, h, "abc", "first-pass")
	h.leave(a)

	if got := roomCount(h); got != 0 {
		t.Fatalf("rooms after the last leave = %d, want 0", got)
	}

	b, fresh := joinPeer(t, h, "abc", "second-pass")
	if fresh == room {
		t.Fatal("rejoin reused the dropped room")
	}
	if _, err := h.join("abc", "first-pass", newPeer()); err != errRoomUnavailable {
		t.Fatalf("old passphrase on the new room: err = %v, want errRoomUnavailable", err)
	}
	h.leave(b)
}

// A state message carries three flags now. A nil pointer must leave its flag
// as it was, so a client that sends only the microphone keeps the rest.
func TestFlagsCarryDeafWithoutClearingTheRest(t *testing.T) {
	p := newPeer()
	mic, deaf := true, true
	if m, c, d := p.setFlags(&mic, nil, &deaf); m != true || c != true || d != true {
		t.Fatalf("setFlags = %v %v %v, want true true true", m, c, d)
	}
	if m, c, d := p.setFlags(nil, nil, boolp(false)); m != true || c != true || d != false {
		t.Fatalf("setFlags = %v %v %v, want true true false", m, c, d)
	}
	if m, c, d := p.flags(); m != true || c != true || d != false {
		t.Fatalf("flags = %v %v %v, want true true false", m, c, d)
	}
}

func boolp(v bool) *bool { return &v }
