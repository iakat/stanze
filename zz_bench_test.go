package main

import (
	"strconv"
	"testing"
)

func benchHub(b *testing.B, n int) (*Hub, *Peer) {
	h := newHub(&Config{MaxPeers: 32, MaxRooms: 50})
	var first *Peer
	for i := 0; i < n; i++ {
		p := newPeer()
		if _, err := h.join("bench", p); err != nil {
			b.Fatal(err)
		}
		if first == nil {
			first = p
		}
		// Drain so a full queue never closes the peer mid measurement.
		go func(ch <-chan []byte) {
			for range ch {
			}
		}(p.send)
	}
	return h, first
}

func BenchmarkBroadcast(b *testing.B) {
	for _, n := range []int{2, 8, 32} {
		h, p := benchHub(b, n)
		payload := []byte(`{"t":"enc","b":"xxxx"}`)
		b.Run("peers="+strconv.Itoa(n), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				h.broadcast(p, payload)
			}
		})
	}
}
