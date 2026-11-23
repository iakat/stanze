package main

import (
	"net/http/httptest"
	"testing"
)

// The per address limits hang off clientAddr, so the header order decides who
// gets a fresh window. A proxy appends the address it saw, which makes every
// entry on the left the client's own words.
func TestClientAddrTakesTheAddressTheProxySaw(t *testing.T) {
	for _, tc := range []struct {
		name   string
		remote string
		xff    string
		want   string
	}{
		{"single entry", "10.0.0.1:1234", "203.0.113.9", "203.0.113.9"},
		{"a forged left entry is ignored", "10.0.0.1:1234", "198.51.100.7, 203.0.113.9", "203.0.113.9"},
		{"two forged left entries", "10.0.0.1:1234", "192.0.2.1, 192.0.2.2, 203.0.113.9", "203.0.113.9"},
		{"trailing spaces", "10.0.0.1:1234", "192.0.2.1 ,  203.0.113.9 ", "203.0.113.9"},
		{"empty entries are skipped", "10.0.0.1:1234", "192.0.2.1, , ", "192.0.2.1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/ws", nil)
			r.RemoteAddr = tc.remote
			r.Header.Set("X-Forwarded-For", tc.xff)
			if got := clientAddr(r, true); got != tc.want {
				t.Fatalf("clientAddr = %q, want %q", got, tc.want)
			}
		})
	}
}

// Without -behind-proxy the header is not read at all.
func TestClientAddrWithoutAProxy(t *testing.T) {
	r := httptest.NewRequest("GET", "/ws", nil)
	r.RemoteAddr = "10.0.0.1:1234"
	r.Header.Set("X-Forwarded-For", "203.0.113.9")
	if got := clientAddr(r, false); got != "10.0.0.1" {
		t.Fatalf("clientAddr = %q, want the socket address", got)
	}
}

// A room that a leave on another goroutine has already dropped must answer
// with an empty list, not panic on a nil room.
func TestHubHelpersSurviveAGoneRoom(t *testing.T) {
	h := newHub(&Config{MaxPeers: 8, MaxRooms: 4})
	if got := h.peersOf(nil, ""); len(got) != 0 {
		t.Fatalf("peersOf(nil) = %v", got)
	}
	if got := h.adminsOf(nil); len(got) != 0 {
		t.Fatalf("adminsOf(nil) = %v", got)
	}
	h.broadcastTo(nil, mustJSON(serverMsg{T: "peer-left"}))
}
