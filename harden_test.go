package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Every test here runs the real handler over a real socket: the limits hold
// because the read loop applies them, not because a helper says so.

func newTestServer(t *testing.T, cfg *Config) (*server, string) {
	t.Helper()
	if cfg.MaxPeers == 0 {
		cfg.MaxPeers = 8
	}
	if cfg.MaxRooms == 0 {
		cfg.MaxRooms = 50
	}
	if cfg.MaxMsgBytes == 0 {
		cfg.MaxMsgBytes = 1 << 18
	}
	srv := newServer(cfg, newHub(cfg), slog.New(slog.NewTextHandler(io.Discard, nil)))
	ts := httptest.NewServer(srv.handleWSHandler())
	t.Cleanup(ts.Close)
	return srv, "ws" + strings.TrimPrefix(ts.URL, "http")
}

// ---------------------------------------------------------------- M3, B3

// encBlob makes a valid JSON string body of exactly n bytes: the two quotes
// and n-2 characters, so a boundary can be hit to the byte.
func encBlob(n int) string {
	return `"` + strings.Repeat("A", n-2) + `"`
}

// The relay's size and shape rules answer the sender. A silent drop leaves the
// receiver's sequence counter one behind for the rest of the call, so every
// refusal has to be visible to the page that caused it.
func TestHandleEncBoundsAnswerTheSender(t *testing.T) {
	cases := []struct {
		name string
		b    string
		code string // "" means the frame is relayed
	}{
		{"non base64 JSON number", `12345`, "bad-frame"},
		{"non base64 JSON object", `{"a":1}`, "bad-frame"},
		{"non base64 JSON true", `true`, "bad-frame"},
		// A bare quote makes the frame invalid JSON, so it is refused as a
		// malformed frame before handleEnc ever sees the body.
		{"a bare quote is invalid JSON", `"`, "bad-message"},
		{"just under 96 KiB", encBlob(encMax - 1), ""},
		{"exactly 96 KiB", encBlob(encMax), ""},
		{"96 KiB plus one", encBlob(encMax + 1), "too-big"},
		// Anything past the socket read limit is refused by the connection
		// itself (gorilla closes it) rather than reaching this handler, so a
		// 256 KiB body is not a row here: it never gets this far.
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, url := newTestServer(t, &Config{})
			a, _ := wireJoin(t, url, "bound-room")
			b, _ := wireJoin(t, url, "bound-room")
			if _, ok := a.next("peer-joined", 2*time.Second); !ok {
				t.Fatal("the member was not told that a peer joined")
			}
			// The body is written as raw JSON so the exact byte count reaches
			// the handler: WriteJSON would quote the string again.
			if err := a.conn.WriteMessage(1, []byte(`{"t":"enc","to":"`+b.self+`","b":`+tc.b+`}`)); err != nil {
				t.Fatalf("send: %v", err)
			}
			if tc.code == "" {
				if m, ok := b.next("enc", 3*time.Second); !ok || m["from"] != a.self {
					t.Fatalf("a frame inside the bound was not relayed: %v", m)
				}
				return
			}
			m, ok := a.next("error", 3*time.Second)
			if !ok {
				t.Fatalf("no error frame came back for %s", tc.name)
			}
			if m["code"] != tc.code {
				t.Fatalf("code = %v, want %q", m["code"], tc.code)
			}
			// The blob never reaches the room.
			if m, ok := b.next("enc", 300*time.Millisecond); ok {
				t.Fatalf("a refused frame was relayed anyway: %v", m)
			}
		})
	}
}

// The error frame is the exact shape the client's handler reads, and it is
// additive: no other field appears.
func TestErrorFrameShape(t *testing.T) {
	s := &server{}
	p := newPeer()
	// enqueue never blocks (a full queue drops with a false), so nothing has
	// to drain the buffer: reading the frame straight out is enough.
	s.tooBig(p, "too-big")
	var m map[string]any
	if err := json.Unmarshal(<-p.send, &m); err != nil {
		t.Fatal(err)
	}
	if len(m) != 2 || m["t"] != "error" || m["code"] != "too-big" {
		t.Fatalf("error frame = %v", m)
	}
}

// The room budget is paid for by the sender that overran it, not by the guest
// it could not reach. A slow receiver no longer takes the receiver down; a
// sender whose frames reach nobody for the whole loss window is the one
// closed.
func TestRoomBudgetClosesTheFlooder(t *testing.T) {
	srv := newServer(&Config{}, newHub(&Config{}), slog.New(slog.NewTextHandler(io.Discard, nil)))
	p := newPeer()
	small := encBlob(64)
	// One frame opens the account, as a real relay would.
	if !srv.spend(p, len(small)) {
		t.Fatal("the first frame was refused")
	}
	srv.nothingReached(p)

	// With the window open the very next frame is refused.
	old := lostFrameBudget
	lostFrameBudget = time.Nanosecond
	t.Cleanup(func() { lostFrameBudget = old })
	time.Sleep(time.Microsecond)
	if srv.spend(p, len(small)) {
		t.Fatal("a sender that reached nobody for a window was still allowed to relay")
	}

	// A frame that gets through again clears the mark: a receiver that keeps
	// up must not punish its sender for one slow moment.
	fresh := newPeer()
	srv.spend(fresh, len(small))
	srv.nothingReached(fresh)
	time.Sleep(time.Microsecond)
	if srv.spend(fresh, len(small)) {
		t.Fatal("spend did not see the stale loss mark")
	}
	srv.delivered(fresh)
	if !srv.spend(fresh, len(small)) {
		t.Fatal("a delivered frame did not clear the loss mark")
	}
}

// The relay budget belongs to the room, not to each peer: a caller with eight
// sockets does not get eight times the room's allowance.
func TestBudgetIsTheRoomsNotThePeers(t *testing.T) {
	cfg := &Config{MaxPeers: 8, MaxRooms: 8}
	srv := newServer(cfg, newHub(cfg), slog.New(slog.NewTextHandler(io.Discard, nil)))
	hub := srv.hub
	peers := make([]*Peer, 0, 8)
	for i := 0; i < 8; i++ {
		p := newPeer()
		p.id = "p" + string(rune('a'+i))
		if _, err := hub.join("budget-room", p); err != nil {
			t.Fatalf("join %d: %v", i, err)
		}
		peers = append(peers, p)
	}
	// Drain the whole room allowance through the first socket.
	size := 64
	spent := 0
	for srv.spend(peers[0], size) {
		spent++
		if spent > 10000 {
			t.Fatal("the room bucket never emptied")
		}
	}
	// A second guest of the same room shares that bucket, so it is empty too.
	if srv.spend(peers[1], size) {
		t.Fatal("a second peer of the same room had its own bucket")
	}
	// A peer of another room is unaffected.
	other := newPeer()
	other.id = "other"
	if _, err := hub.join("another-room", other); err != nil {
		t.Fatal(err)
	}
	if !srv.spend(other, size) {
		t.Fatal("one room's flood took another room's allowance")
	}
}

// A slow receiver is not closed by its sender's burst: the frame is dropped
// for it, so the guest that cannot keep up stays in the call.
func TestFullQueueDropsForTheReceiver(t *testing.T) {
	p := newPeer()
	for i := 0; i < cap(p.send); i++ {
		if !p.enqueue([]byte(`{}`)) {
			t.Fatalf("enqueue %d failed inside the queue", i)
		}
	}
	closed := false
	p.onClose = func() { closed = true }
	if p.enqueue([]byte(`{}`)) {
		t.Fatal("a full queue took one more frame")
	}
	if closed {
		t.Fatal("a full queue closed the receiver")
	}
}

// ---------------------------------------------------------------- M6

// A relay credential is a portable UDP relay, so it is not part of the join
// and is minted once, for a pair that exists in the room.
func TestRelayMintedOnRequestOnlyOnce(t *testing.T) {
	cfg := &Config{Turn: true, TurnSecret: "s3cret", TurnPublicIP: "203.0.113.7",
		TurnPort: 3478, TurnMinPort: 49200, TurnMaxPort: 49300, TurnRealm: "stanze",
		TurnTTL: 10 * time.Minute}
	srv, url := newTestServer(t, cfg)
	mints := 0
	srv.mint = func(tag string) []iceServer {
		mints++
		return []iceServer{{URLs: []string{"turn:203.0.113.7:3478?transport=udp"}, Username: tag, Credential: "x"}}
	}

	a, joined := wireJoin(t, url, "relay-room")
	if _, ok := joined["ice"]; ok {
		t.Fatalf("the join still carries relay credentials: %v", joined)
	}
	b, _ := wireJoin(t, url, "relay-room")
	a.next("peer-joined", 2*time.Second)

	// A pair that is not in the room gets nothing.
	a.send(map[string]any{"t": "ice", "to": "aaaaaaaaaaaa"})
	if m, ok := a.next("error", 2*time.Second); !ok || m["code"] != "unavailable" {
		t.Fatalf("an unknown pair was answered: %v", m)
	}
	if mints != 0 {
		t.Fatalf("a credential was minted for an unknown pair (%d)", mints)
	}

	// A real pair gets one.
	a.send(map[string]any{"t": "ice", "to": b.self})
	m, ok := a.next("ice", 2*time.Second)
	if !ok {
		t.Fatal("a proven pair was refused its relay")
	}
	if mints != 1 {
		t.Fatalf("mints = %d, want 1", mints)
	}
	var list []iceServer
	if err := json.Unmarshal(mustJSON(m["ice"]), &list); err != nil || len(list) == 0 || list[0].Username == "" {
		t.Fatalf("ice = %v (%v)", m["ice"], err)
	}

	// One join, one credential: a second ask is refused.
	a.send(map[string]any{"t": "ice", "to": b.self})
	if m, ok := a.next("error", 2*time.Second); !ok || m["code"] != "relay-exhausted" {
		t.Fatalf("a second credential was offered: %v", m)
	}
	if mints != 1 {
		t.Fatalf("mints = %d, want 1", mints)
	}
}

// A mint that fails must not spend the connection's one credential: the peer
// asks again and gets a real one. Setting the mark before the mint answered
// relay-exhausted to every later ask, for the life of the socket.
func TestRelayMintFailureDoesNotSpendTheCredential(t *testing.T) {
	cfg := &Config{Turn: true, TurnSecret: "s3cret", TurnPublicIP: "203.0.113.7",
		TurnPort: 3478, TurnMinPort: 49200, TurnMaxPort: 49300, TurnRealm: "stanze",
		TurnTTL: 10 * time.Minute}
	srv, url := newTestServer(t, cfg)
	fail := true
	srv.mint = func(tag string) []iceServer {
		if fail {
			return nil
		}
		return []iceServer{{URLs: []string{"turn:203.0.113.7:3478?transport=udp"}, Username: tag, Credential: "x"}}
	}

	a, _ := wireJoin(t, url, "mint-room")
	b, _ := wireJoin(t, url, "mint-room")
	a.next("peer-joined", 2*time.Second)

	// The first ask fails: the page is told there is no relay now, not that
	// its credential is spent.
	a.send(map[string]any{"t": "ice", "to": b.self})
	if m, ok := a.next("error", 2*time.Second); !ok || m["code"] != "relay-off" {
		t.Fatalf("a failed mint was not reported as relay-off: %v", m)
	}

	// The second ask, now that the mint works, is answered.
	fail = false
	a.send(map[string]any{"t": "ice", "to": b.self})
	if m, ok := a.next("ice", 2*time.Second); !ok || m["ice"] == nil {
		t.Fatalf("the connection never got its credential after a failed mint: %v", m)
	}
}

// ---------------------------------------------------------------- R6

// The room cap keeps a margin: a flood of one-socket rooms is refused before
// the map is full, and a call that is already up keeps admitting.
func TestRoomHeadroomRefusesNewRoomsNotJoins(t *testing.T) {
	warned := 0
	h := newHub(&Config{MaxRooms: 10, MaxPeers: 8})
	h.log = func(rooms, limit int) { warned++ }
	limit := h.roomLimit()
	if limit != 8 {
		t.Fatalf("roomLimit = %d, want 8 of 10", limit)
	}
	var first *Peer
	for i := 0; i < limit; i++ {
		p := newPeer()
		if _, err := h.join("r"+string(rune('a'+i)), p); err != nil {
			t.Fatalf("join %d under the limit: %v", i, err)
		}
		if first == nil {
			first = p
		}
	}
	if p := newPeer(); func() bool { _, err := h.join("new-room", p); return err == nil }() {
		t.Fatal("a new room was made past the headroom")
	}
	if warned == 0 {
		t.Fatal("reaching the threshold was not reported")
	}
	// The room that is up still admits.
	if _, err := h.join("ra", newPeer()); err != nil {
		t.Fatalf("a join to an existing room was refused: %v", err)
	}
	if got := roomCount(h); got != limit {
		t.Fatalf("rooms = %d, want %d", got, limit)
	}
	_ = first

	// A tiny cap still makes one room.
	one := newHub(&Config{MaxRooms: 1, MaxPeers: 8})
	if one.roomLimit() != 1 {
		t.Fatalf("roomLimit(1) = %d", one.roomLimit())
	}
}

// The warning names a count and a cap and nothing else. The hook only ever
// receives numbers, so a room id cannot reach it by construction; this pins the
// contract down.
func TestRoomHeadroomWarningCarriesCountsOnly(t *testing.T) {
	var got [][2]int
	h := newHub(&Config{MaxRooms: 2, MaxPeers: 8})
	h.log = func(rooms, limit int) { got = append(got, [2]int{rooms, limit}) }
	if _, err := h.join("secret-room-name", newPeer()); err != nil {
		t.Fatal(err)
	}
	if _, err := h.join("another-secret", newPeer()); err != nil {
		t.Fatal(err)
	}
	if _, err := h.join("third-secret", newPeer()); err == nil {
		t.Fatal("a third room was made past the headroom of two")
	}
	if len(got) != 1 || got[0] != [2]int{2, 2} {
		t.Fatalf("warning calls = %v", got)
	}
	// The same warning at the same moment is not repeated.
	if _, err := h.join("third-secret", newPeer()); err == nil {
		t.Fatal("a third room was made")
	}
	if len(got) != 1 {
		t.Fatalf("the warning repeated inside its window: %v", got)
	}
}

// ---------------------------------------------------------------- R7

// An idle room is dropped and its peers are closed, so a socket that never
// says anything cannot hold a room slot for good.
func TestSweepDropsIdleRooms(t *testing.T) {
	old := roomIdleTimeout
	roomIdleTimeout = 20 * time.Millisecond
	t.Cleanup(func() { roomIdleTimeout = old })

	h := newHub(&Config{MaxPeers: 8, MaxRooms: 50})
	closed := 0
	stale, err := h.join("gone", newPeer())
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range stale.peers {
		p.onClose = func() { closed++ }
	}
	live, err := h.join("live", newPeer())
	if err != nil {
		t.Fatal(err)
	}
	liveClosed := 0
	for _, p := range live.peers {
		p.onClose = func() { liveClosed++ }
	}
	// Time passes; the live room is used.
	time.Sleep(30 * time.Millisecond)
	h.touch(live)
	if n := h.sweepIdle(time.Now()); n != 1 {
		t.Fatalf("swept %d rooms, want 1", n)
	}
	if roomInMap(h, "gone") != nil {
		t.Fatal("the idle room survived the sweep")
	}
	if closed != 1 {
		t.Fatalf("closed %d peers of the idle room, want 1", closed)
	}
	if roomInMap(h, "live") == nil || liveClosed != 0 {
		t.Fatal("the live room was taken by the sweep")
	}
}

// A silent socket is cut at the deadline; a frame pushes it forward again.
func TestDeadlineIsPushedByEveryFrame(t *testing.T) {
	_, url := newTestServer(t, &Config{})
	a, _ := wireJoin(t, url, "deadline-room")
	// Past the join deadline, a frame still goes through: the join re-armed
	// it and the frame re-arms it in turn.
	time.Sleep(joinTimeout + 200*time.Millisecond)
	a.send(map[string]any{"t": "ping"})
	if _, ok := a.next("pong", 3*time.Second); !ok {
		t.Fatal("a frame after the join deadline was not served")
	}
}

// roomLastSeen reads when a room last carried a sign of life, under the hub
// lock, so a test can wait for a touch without racing the read path.
func roomLastSeen(h *Hub, id string) time.Time {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r := h.rooms[id]; r != nil {
		return r.lastSeen
	}
	return time.Time{}
}

// waitTouched waits until a room's lastSeen moves past before, and fails the
// test if it does not within the budget.
func waitTouched(t *testing.T, h *Hub, id string, before time.Time) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for roomLastSeen(h, id).Equal(before) {
		if time.Now().After(deadline) {
			t.Fatalf("room %q was never touched", id)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// A call carries no application frame once it is up: the media, positions and
// chat ride the sealed channels of each pair, and the only WebSocket traffic
// left is the keepalive the server pings and the browser answers. That pong
// proves the guest is still in the room, so it has to keep the room from the
// sweep. A room that really carries nothing is still dropped by the same
// sweep, which is what keeps the timeout meaningful.
func TestKeepalivePongKeepsALiveCallFromTheSweep(t *testing.T) {
	old := roomIdleTimeout
	roomIdleTimeout = 150 * time.Millisecond
	t.Cleanup(func() { roomIdleTimeout = old })

	srv, url := newTestServer(t, &Config{})
	live, _ := wireJoin(t, url, "call-room")
	silent, _ := wireJoin(t, url, "silent-room")

	// Past the timeout with no frame of any kind: both rooms are stale now.
	time.Sleep(2 * roomIdleTimeout)
	before := roomLastSeen(srv.hub, "call-room")
	if time.Since(before) < roomIdleTimeout {
		t.Fatalf("the room aged %v, which is inside the timeout", time.Since(before))
	}

	// The browser answers the server's keepalive. Nothing else is sent.
	if err := live.conn.WriteControl(websocket.PongMessage, []byte("keepalive"), time.Now().Add(time.Second)); err != nil {
		t.Fatalf("pong: %v", err)
	}
	waitTouched(t, srv.hub, "call-room", before)

	// The sweep takes the room that said nothing and leaves the one that
	// answered its keepalive.
	if n := srv.hub.sweepIdle(time.Now()); n != 1 {
		t.Fatalf("swept %d rooms, want 1", n)
	}
	if roomInMap(srv.hub, "call-room") == nil {
		t.Fatal("a room whose only traffic was a pong was swept")
	}
	if roomInMap(srv.hub, "silent-room") != nil {
		t.Fatal("a room with no traffic at all survived the sweep")
	}
	// The guests of the swept room hear the socket close.
	if _, ok := silent.next("", 2*time.Second); ok {
		t.Fatal("the swept room's socket stayed open")
	}
}

// A client ping is answered and counts the same way: it says the guest is
// still there just as a pong does.
func TestClientPingAlsoTouchesTheRoom(t *testing.T) {
	srv, url := newTestServer(t, &Config{})
	a, _ := wireJoin(t, url, "ping-room")
	before := roomLastSeen(srv.hub, "ping-room")
	if err := a.conn.WriteControl(websocket.PingMessage, []byte("hello"), time.Now().Add(time.Second)); err != nil {
		t.Fatalf("ping: %v", err)
	}
	waitTouched(t, srv.hub, "ping-room", before)
}

// A keepalive from a socket that is not in a room yet touches nothing: no room
// appears, and the socket is still usable for the join that follows.
func TestKeepaliveBeforeJoinTouchesNothing(t *testing.T) {
	srv, url := newTestServer(t, &Config{})
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	c := newWireClient(t, conn)

	// Two keepalives from a peer with no room: a ping the server answers and a
	// pong nobody answers. Neither may make a room.
	if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(time.Second)); err != nil {
		t.Fatalf("ping: %v", err)
	}
	if err := conn.WriteControl(websocket.PongMessage, nil, time.Now().Add(time.Second)); err != nil {
		t.Fatalf("pong: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	if got := roomCount(srv.hub); got != 0 {
		t.Fatalf("%d rooms were made by a keepalive from a peer with no room", got)
	}
	// The socket is untouched by the handlers: the join still goes through.
	c.send(map[string]any{"t": "join", "room": "after-keepalive"})
	if m, ok := c.next("joined", 3*time.Second); !ok || m["self"] == "" {
		t.Fatalf("the join after a keepalive failed: %v", m)
	}
	if roomCount(srv.hub) != 1 {
		t.Fatal("the join did not make its room")
	}
}

// ---------------------------------------------------------------- A6

// The socket cap is per address and goes back down when a connection closes.
func TestLiveSocketsCapPerAddress(t *testing.T) {
	l := newLiveSockets(2)
	if !l.acquire("1.2.3.4") || !l.acquire("1.2.3.4") {
		t.Fatal("the first two sockets were refused")
	}
	if l.acquire("1.2.3.4") {
		t.Fatal("a third socket was allowed past a cap of two")
	}
	if !l.acquire("5.6.7.8") {
		t.Fatal("another address was refused its own budget")
	}
	l.release("1.2.3.4")
	if !l.acquire("1.2.3.4") {
		t.Fatal("a released slot was not given back")
	}
	if got := l.count("1.2.3.4"); got != 2 {
		t.Fatalf("count = %d, want 2", got)
	}
	l.release("9.9.9.9") // no matching acquire: ignored, not negative
	if got := l.count(""); got != 3 {
		t.Fatalf("total = %d, want 3", got)
	}
}

// ---------------------------------------------------------------- A8

// A shutdown closes every live socket with a close frame, so a tab learns the
// call is over instead of finding a dead connection later. The read loop is
// joined on its own exit signal, not on the reader goroutine: a goroutine that
// has not been scheduled yet would otherwise look like an open socket.
func TestCloseAllClosesLiveSockets(t *testing.T) {
	exited := make(chan string, 4)
	hcfg := &Config{MaxMsgBytes: 1 << 18, MaxPeers: 8, MaxRooms: 50}
	srv := newServer(hcfg, newHub(hcfg), slog.New(slog.NewTextHandler(io.Discard, nil)))
	// The checkOrigin of a bare server refuses a dial that carries no Origin;
	// the test dials the way a same-origin page does.
	srv.upgrader.CheckOrigin = func(*http.Request) bool { return true }
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		who := r.URL.Query().Get("who")
		srv.handleWS(w, r)
		exited <- who
	})
	ts := httptest.NewServer(mux)
	defer ts.Close()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	for _, who := range []string{"a", "b"} {
		conn, _, err := websocket.DefaultDialer.Dial(url+"?who="+who, nil)
		if err != nil {
			t.Fatalf("dial %s: %v", who, err)
		}
		defer conn.Close()
		if err := conn.WriteJSON(map[string]any{"t": "join", "room": "shutdown-room"}); err != nil {
			t.Fatalf("join %s: %v", who, err)
		}
		if _, _, err := conn.ReadMessage(); err != nil {
			t.Fatalf("joined %s: %v", who, err)
		}
	}

	srv.closeAll()

	seen := map[string]bool{}
	for i := 0; i < 2; i++ {
		select {
		case who := <-exited:
			seen[who] = true
		case <-time.After(3 * time.Second):
			t.Fatalf("only %v left after closeAll", seen)
		}
	}
	srv.closeMu.Lock()
	n := len(srv.live)
	srv.closeMu.Unlock()
	if n != 0 {
		t.Fatalf("%d sockets are still listed as live", n)
	}
}
