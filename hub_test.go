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

// Everything the room held dies with it: a later join starts from nothing.
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
	if len(fresh.peers) != 1 || fresh.peers[b.id] == nil {
		t.Fatalf("the new room holds %d peers, want only %s", len(fresh.peers), b.id)
	}
	if b.id == a.id {
		t.Fatal("the new room reused the old peer id")
	}
	h.leave(b)
}

// A peer is only reachable inside its own room, and a leave clears the room it
// points at, so no later lookup can find it through the old one.
func TestPeerLookupStaysInsideTheRoom(t *testing.T) {
	h := newTestHub(t)

	a, room := joinPeer(t, h, "abc")
	other, otherRoom := joinPeer(t, h, "elsewhere")

	if got := h.peerOf(room, a.id); got != a {
		t.Fatalf("peerOf in its own room = %v, want %v", got, a)
	}
	if got := h.peerOf(room, other.id); got != nil {
		t.Fatalf("a peer of another room was found: %v", got)
	}
	if h.peerOf(room, "nobody") != nil {
		t.Fatal("an unknown id was found")
	}

	h.leave(a)
	if a.room != nil {
		t.Fatal("a peer that left still points at its room")
	}
	if h.peerOf(room, a.id) != nil {
		t.Fatal("a peer that left is still in the room")
	}
	h.leave(other)
	if h.peerOf(otherRoom, other.id) != nil {
		t.Fatal("the last peer is still in a dropped room")
	}
}
