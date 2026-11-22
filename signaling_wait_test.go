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

// wireClient is a bare signaling client for the waiting room test. A reader
// goroutine keeps every message, because a read deadline that fires leaves a
// websocket connection unusable.
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
			if m["t"] == want {
				return m, true
			}
		case <-deadline:
			return nil, false
		}
	}
}

func wireJoin(t *testing.T, url, room string) *wireClient {
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
	return c
}

// The waiting room on the wire: the switch is the admin's, a later guest waits
// and is flagged to the room, a waiting guest lets nobody in, a member does,
// and the whole room hears it.
func TestWaitingRoomOnTheWire(t *testing.T) {
	cfg := &Config{MaxPeers: 8, MaxRooms: 50, MaxMsgBytes: 1 << 18}
	srv := newServer(cfg, newHub(cfg), slog.New(slog.NewTextHandler(io.Discard, nil)))
	ts := httptest.NewServer(srv.handleWSHandler())
	defer ts.Close()
	url := "ws" + strings.TrimPrefix(ts.URL, "http")

	a := wireJoin(t, url, "wait-room-test")
	b := wireJoin(t, url, "wait-room-test")
	a.next("peer-joined", time.Second)

	// B holds no admin role: the switch stays off, nobody is told.
	b.send(map[string]any{"t": "mod", "action": "waitingroom", "on": true})
	if _, ok := a.next("waiting-room", 400*time.Millisecond); ok {
		t.Fatal("a guest without the admin role switched the waiting room on")
	}

	a.send(map[string]any{"t": "mod", "action": "waitingroom", "on": true})
	for name, c := range map[string]*wireClient{"admin": a, "member": b} {
		m, ok := c.next("waiting-room", 2*time.Second)
		if !ok || m["waitingRoom"] != true {
			t.Fatalf("%s was not told that the waiting room is on: %v", name, m)
		}
	}

	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	c := newWireClient(t, conn)
	c.send(map[string]any{"t": "join", "room": "wait-room-test"})
	jm, ok := c.next("joined", 3*time.Second)
	if !ok || jm["waiting"] != true || jm["waitingRoom"] != true {
		t.Fatalf("the late guest is not told that it waits: %v", jm)
	}
	c.self, _ = jm["self"].(string)

	pj, ok := a.next("peer-joined", 2*time.Second)
	peer, _ := pj["peer"].(map[string]any)
	if !ok || peer["waiting"] != true {
		t.Fatalf("the room is not told that the guest waits: %v", pj)
	}

	// The waiting guest can not let itself in; a member can.
	c.send(map[string]any{"t": "admit", "to": c.self})
	if _, ok := a.next("admitted", 400*time.Millisecond); ok {
		t.Fatal("a waiting guest let itself in")
	}
	b.send(map[string]any{"t": "admit", "to": c.self})
	for name, who := range map[string]*wireClient{"admin": a, "waiting guest": c} {
		m, ok := who.next("admitted", 2*time.Second)
		p, _ := m["peer"].(map[string]any)
		if !ok || p["id"] != c.self {
			t.Fatalf("%s did not hear the admit: %v", name, m)
		}
	}
}
