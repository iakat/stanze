package main

import "testing"

func newTestHub(t *testing.T) *Hub {
	t.Helper()
	return newHub(&Config{MaxPeers: 8, MaxRooms: 50})
}

func joinPeer(t *testing.T, h *Hub, roomID string) (*Peer, *Room) {
	t.Helper()
	p := newPeer()
	room, err := h.join(roomID, p)
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

	p, room := joinPeer(t, h, "abc")
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

	a, _ := joinPeer(t, h, "abc")
	b, _ := joinPeer(t, h, "abc")

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

	a, room := joinPeer(t, h, "abc")
	b, _ := joinPeer(t, h, "abc")
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
// no admin, no waiting room and no order.
func TestRejoinAfterDropStartsFresh(t *testing.T) {
	h := newTestHub(t)

	a, room := joinPeer(t, h, "abc")
	h.leave(a)

	if got := roomCount(h); got != 0 {
		t.Fatalf("rooms after the last leave = %d, want 0", got)
	}

	b, fresh := joinPeer(t, h, "abc")
	if fresh == room {
		t.Fatal("rejoin reused the dropped room")
	}
	if len(fresh.admins) != 1 || !fresh.admins[b.id] {
		t.Fatalf("the first guest of the new room is not admin: %v", fresh.admins)
	}
	h.leave(b)
}

// A state message carries four flags now. A nil pointer must leave its flag
// as it was, so a client that sends only the microphone keeps the rest.
func TestFlagsCarryDeafWithoutClearingTheRest(t *testing.T) {
	p := newPeer()
	mic, deaf, share := true, true, true
	if m, c, d, sc := p.setFlags(&mic, nil, &deaf, &share); m != true || c != true || d != true || sc != true {
		t.Fatalf("setFlags = %v %v %v %v, want true true true true", m, c, d, sc)
	}
	if m, c, d, sc := p.setFlags(nil, nil, boolp(false), nil); m != true || c != true || d != false || sc != true {
		t.Fatalf("setFlags = %v %v %v %v, want true true false true", m, c, d, sc)
	}
	if m, c, d, sc := p.flags(); m != true || c != true || d != false || sc != true {
		t.Fatalf("flags = %v %v %v %v, want true true false true", m, c, d, sc)
	}
	if m, c, d, sc := p.setFlags(nil, nil, nil, boolp(false)); m != true || c != true || d != false || sc != false {
		t.Fatalf("setFlags = %v %v %v %v, want true true false false", m, c, d, sc)
	}
}

func boolp(v bool) *bool { return &v }

// With the switch off nobody waits, whatever the room holds.
func TestWaitingRoomOffLetsEveryoneIn(t *testing.T) {
	h := newTestHub(t)
	a, room := joinPeer(t, h, "abc")
	b, _ := joinPeer(t, h, "abc")
	if h.isWaiting(a) || h.isWaiting(b) {
		t.Fatal("a guest waited while the waiting room was off")
	}
	if h.waitingRoomOn(room) {
		t.Fatal("a fresh room has the waiting room on")
	}
}

// The first guest is never held, a later guest waits while the switch is on,
// and a waiting guest never gets the admin role.
func TestWaitingRoomHoldsLaterGuests(t *testing.T) {
	h := newTestHub(t)
	a, room := joinPeer(t, h, "abc")
	h.setWaitingRoom(room, true)
	b, _ := joinPeer(t, h, "abc")

	if h.isWaiting(a) {
		t.Fatal("a member was put in the waiting room by the switch")
	}
	if !h.isWaiting(b) {
		t.Fatal("a guest who joined after the switch did not wait")
	}
	if h.grantAdmin(room, b.id) {
		t.Fatal("a waiting guest was given the admin role")
	}
	if h.isAdmin(room, b.id) {
		t.Fatal("a waiting guest holds the admin role")
	}
}

// A room switched on before anybody joined still lets the first guest in.
func TestWaitingRoomFirstGuestIsNeverHeld(t *testing.T) {
	h := newTestHub(t)
	a, room := joinPeer(t, h, "abc")
	h.setWaitingRoom(room, true)
	h.leave(a)
	c, _ := joinPeer(t, h, "abc")
	if h.isWaiting(c) {
		t.Fatal("the first guest of a fresh room waited for nobody")
	}
}

// Only a guest who is inside lets a waiting guest in, and only one that
// waits in the same room.
func TestAdmitRules(t *testing.T) {
	h := newTestHub(t)
	a, room := joinPeer(t, h, "abc")
	h.setWaitingRoom(room, true)
	b, _ := joinPeer(t, h, "abc")
	c, _ := joinPeer(t, h, "abc")

	if h.admit(b, c.id) {
		t.Fatal("a waiting guest let another guest in")
	}
	if h.admit(a, a.id) {
		t.Fatal("a guest admitted itself")
	}
	if h.admit(a, "nobody") {
		t.Fatal("an unknown id was admitted")
	}
	other, _ := joinPeer(t, h, "elsewhere")
	if h.admit(other, b.id) {
		t.Fatal("a guest of another room let a guest in")
	}
	if !h.admit(a, b.id) {
		t.Fatal("a member could not let a waiting guest in")
	}
	if h.isWaiting(b) {
		t.Fatal("the admitted guest still waits")
	}
	if !h.isWaiting(c) {
		t.Fatal("the other waiting guest was let in with it")
	}
	if h.admit(a, b.id) {
		t.Fatal("a guest who is inside was admitted a second time")
	}
	// An admitted guest is a member now and may let the next one in.
	if !h.admit(b, c.id) {
		t.Fatal("an admitted guest could not let the next one in")
	}
}

// When the last member leaves, the guest who has waited longest is let in, so
// a room never holds guests outside for a host that is gone. The role goes to
// that guest, not to one who still waits.
func TestLastMemberLeavesLetsOldestWaiterIn(t *testing.T) {
	h := newTestHub(t)
	a, room := joinPeer(t, h, "abc")
	h.setWaitingRoom(room, true)
	b, _ := joinPeer(t, h, "abc")
	c, _ := joinPeer(t, h, "abc")

	_, letIn := h.leaveWith(a)
	if letIn != b.id {
		t.Fatalf("let in = %q, want the oldest waiter %q", letIn, b.id)
	}
	if h.isWaiting(b) {
		t.Fatal("the oldest waiter still waits")
	}
	if !h.isWaiting(c) {
		t.Fatal("the second waiter was let in too")
	}
	admins := h.adminsOf(room)
	if len(admins) != 1 || admins[0] != b.id {
		t.Fatalf("admins = %v, want only %s", admins, b.id)
	}
}

// A member leaving while another member stays lets nobody in.
func TestMemberLeaveKeepsWaiterOutside(t *testing.T) {
	h := newTestHub(t)
	a, room := joinPeer(t, h, "abc")
	b, _ := joinPeer(t, h, "abc")
	h.setWaitingRoom(room, true)
	c, _ := joinPeer(t, h, "abc")

	_, letIn := h.leaveWith(a)
	if letIn != "" {
		t.Fatalf("a waiter was let in while a member stayed: %q", letIn)
	}
	if !h.isWaiting(c) || h.isWaiting(b) {
		t.Fatal("the waiting states changed")
	}
}
