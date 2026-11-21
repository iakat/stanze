package main

import (
	"testing"
	"time"
)

// testClock is the hub clock under test control, so no test sleeps.
type testClock struct{ t time.Time }

func (c *testClock) now() time.Time          { return c.t }
func (c *testClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newTestHub(t *testing.T, ttl time.Duration) (*Hub, *testClock) {
	t.Helper()
	h := newHub(&Config{MaxPeers: 8, MaxRooms: 50, EmptyRoomTTL: ttl})
	c := &testClock{t: time.Unix(1700000000, 0)}
	h.now = c.now
	return h, c
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
	h, _ := newTestHub(t, time.Minute)

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
	h, _ := newTestHub(t, time.Minute)

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
	h, _ := newTestHub(t, time.Minute)

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

// A room created ahead of the first join waits for its first peer, then the
// reaper drops it.
func TestReaperDropsRoomCreatedAheadOfFirstJoin(t *testing.T) {
	const ttl = time.Minute
	h, clock := newTestHub(t, ttl)

	id, err := h.create("open-sesame")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	clock.advance(ttl / 2)
	h.reap()
	if roomInMap(h, id) == nil {
		t.Fatal("room dropped before its ttl ran out")
	}

	clock.advance(ttl)
	h.reap()
	if roomInMap(h, id) != nil {
		t.Fatal("room that was never joined survived its ttl")
	}
	if got := roomCount(h); got != 0 {
		t.Fatalf("rooms after reap = %d, want 0", got)
	}
}

// The reaper never touches a room with a peer in it, whatever its age.
func TestReaperKeepsRoomWithPeers(t *testing.T) {
	h, clock := newTestHub(t, time.Minute)

	joinPeer(t, h, "abc", "")
	clock.advance(time.Hour)
	h.reap()

	if roomInMap(h, "abc") == nil {
		t.Fatal("reaper dropped a room with a peer in it")
	}
}

// A room that was created ahead of the first join keeps its passphrase when
// the first peer joins inside the ttl.
func TestPreCreatedRoomKeepsItsPassphrase(t *testing.T) {
	h, _ := newTestHub(t, time.Minute)

	id, err := h.create("open-sesame")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	joinPeer(t, h, id, "open-sesame")

	if _, err := h.join(id, "wrong", newPeer()); err != errRoomUnavailable {
		t.Fatalf("join with a wrong passphrase: err = %v, want errRoomUnavailable", err)
	}
}

// Everything the room held dies with it: a later join starts from nothing, so
// no state and a passphrase the newcomer picks.
func TestRejoinAfterDropStartsFresh(t *testing.T) {
	h, _ := newTestHub(t, time.Minute)

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
