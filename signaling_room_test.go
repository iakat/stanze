package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// wireClient is a bare signaling client for the room tests. A reader goroutine
// keeps every message, because a read deadline that fires leaves a websocket
// connection unusable.
type wireClient struct {
	t    *testing.T
	conn *websocket.Conn
	self string
	msgs chan map[string]any
}

func newWireClient(t *testing.T, conn *websocket.Conn) *wireClient {
	c := &wireClient{t: t, conn: conn, msgs: make(chan map[string]any, 64)}
	go func() {
		defer close(c.msgs)
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(data, &m) == nil {
				c.msgs <- m
			}
		}
	}()
	return c
}

func (c *wireClient) send(v any) {
	c.t.Helper()
	if err := c.conn.WriteJSON(v); err != nil {
		c.t.Fatalf("send: %v", err)
	}
}

// next reads until a message of type want arrives. It returns ok=false on a
// timeout, so a test can also assert that nothing came.
func (c *wireClient) next(want string, wait time.Duration) (map[string]any, bool) {
	c.t.Helper()
	deadline := time.After(wait)
	for {
		select {
		case m, ok := <-c.msgs:
			if !ok {
				return nil, false
			}
			if want == "" || m["t"] == want {
				return m, true
			}
		case <-deadline:
			return nil, false
		}
	}
}

func wireJoin(t *testing.T, url, room string) (*wireClient, map[string]any) {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	c := newWireClient(t, conn)
	c.send(map[string]any{"t": "join", "room": room})
	m, ok := c.next("joined", 3*time.Second)
	if !ok {
		t.Fatal("no joined message")
	}
	c.self, _ = m["self"].(string)
	return c, m
}

// The join names nobody and the knock carries one opaque id: no roster, no
// role, no waiting flag. A guest that holds the room id learns nothing from the
// server, and the members learn one id from the knock and nothing else.
func TestJoinAndKnockCarryNoRoomState(t *testing.T) {
	cfg := &Config{MaxPeers: 8, MaxRooms: 50, MaxMsgBytes: 1 << 18}
	srv := newServer(cfg, newHub(cfg), slog.New(slog.NewTextHandler(io.Discard, nil)))
	ts := httptest.NewServer(srv.handleWSHandler())
	defer ts.Close()
	url := "ws" + strings.TrimPrefix(ts.URL, "http")

	a, first := wireJoin(t, url, "room-test")
	for _, key := range []string{"peers", "admins", "waiting", "waitingRoom"} {
		if _, ok := first[key]; ok {
			t.Fatalf("the first join carries %q: %v", key, first)
		}
	}
	if first["self"] == "" {
		t.Fatalf("the first join carries no peer id: %v", first)
	}

	_, second := wireJoin(t, url, "room-test")
	for _, key := range []string{"peers", "admins", "waiting", "waitingRoom"} {
		if _, ok := second[key]; ok {
			t.Fatalf("a later join carries %q: %v", key, second)
		}
	}

	knock, ok := a.next("peer-joined", 2*time.Second)
	if !ok {
		t.Fatal("the member was not told that a peer joined")
	}
	peer, _ := knock["peer"].(map[string]any)
	if peer == nil || peer["id"] == "" {
		t.Fatalf("the knock carries no id: %v", knock)
	}
	for _, key := range []string{"admin", "waiting", "name", "sealed"} {
		if _, ok := peer[key]; ok {
			t.Fatalf("the knock carries %q: %v", key, knock)
		}
	}
}

// The clear room commands are gone. A page that still sends one gets nothing
// back: no frame of any kind reaches it or the room, so a role, a waiting flag,
// a mute and a kick can only travel sealed.
func TestClearRoomCommandsAreIgnored(t *testing.T) {
	cfg := &Config{MaxPeers: 8, MaxRooms: 50, MaxMsgBytes: 1 << 18}
	srv := newServer(cfg, newHub(cfg), slog.New(slog.NewTextHandler(io.Discard, nil)))
	ts := httptest.NewServer(srv.handleWSHandler())
	defer ts.Close()
	url := "ws" + strings.TrimPrefix(ts.URL, "http")

	a, _ := wireJoin(t, url, "cmd-test")
	b, _ := wireJoin(t, url, "cmd-test")
	if _, ok := a.next("peer-joined", 2*time.Second); !ok {
		t.Fatal("the member was not told that a peer joined")
	}

	for _, cmd := range []map[string]any{
		{"t": "mod", "action": "waitingroom", "on": true},
		{"t": "mod", "to": b.self, "action": "admin"},
		{"t": "mod", "to": b.self, "action": "mute"},
		{"t": "mod", "to": b.self, "action": "kick"},
		{"t": "admit", "to": b.self},
	} {
		a.send(cmd)
		if m, ok := b.next("", 300*time.Millisecond); ok {
			t.Fatalf("%v produced a frame: %v", cmd, m)
		}
	}
	// The sockets are still in the room and still relay.
	a.send(map[string]any{"t": "enc", "to": b.self, "b": `"AAAA"`})
	if m, ok := b.next("enc", 2*time.Second); !ok || m["from"] != a.self {
		t.Fatalf("the blind relay stopped working: %v", m)
	}
}
