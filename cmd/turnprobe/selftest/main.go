// Command selftest exercises a running server over the network: HTTP routes,
// signaling relay, room isolation, limits, and two real pion WebRTC peers in
// a full mesh, both directly and forced through the embedded TURN relay.
//
//	go run ./cmd/selftest -addr http://127.0.0.1:8095
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

var (
	baseURL  string
	httpBase string
	failures int
	checks   int
	b32Lower = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)
)

func report(name string, err error) {
	checks++
	if err != nil {
		failures++
		fmt.Printf("FAIL  %s\n        %v\n", name, err)
		return
	}
	fmt.Printf("PASS  %s\n", name)
}

func reportf(name string, format string, args ...any) {
	report(name, fmt.Errorf(format, args...))
}

// ---------------------------------------------------------------- http

func httpDo(method, path string, body string) (int, []byte, error) {
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, httpBase+path, r)
	if err != nil {
		return 0, nil, err
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	return res.StatusCode, b, err
}

type peerInfo struct {
	ID string `json:"id"`
}

type iceCfg struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

type sigMsg struct {
	T     string     `json:"t"`
	Self  string     `json:"self"`
	Peers []peerInfo `json:"peers"`
	Peer  *peerInfo  `json:"peer"`
	From  string     `json:"from"`
	Code  string     `json:"code"`
	Ice   []iceCfg   `json:"ice"`

	// B is another peer's opaque payload. In the browser it holds ciphertext;
	// here it carries this same struct, base64 encoded, so the suite drives its
	// peers over the path a browser takes. SDP and Candidate are only ever set
	// inside B, never on a frame of their own.
	B         string          `json:"b"`
	SDP       string          `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
}

type sigClient struct {
	conn *websocket.Conn
	self string
	ice  []iceCfg

	msgs chan sigMsg

	mu      sync.Mutex
	handler func(sigMsg)
	seen    []sigMsg
}

func wsEndpoint() (string, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	}
	u.Path = "/ws"
	u.RawQuery = ""
	return u.String(), nil
}

func dialSig() (*sigClient, error) {
	endpoint, err := wsEndpoint()
	if err != nil {
		return nil, err
	}

	conn, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(1 << 20)
	c := &sigClient{conn: conn, msgs: make(chan sigMsg, 128)}

	go func() {
		defer close(c.msgs)
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var m sigMsg
			if err := json.Unmarshal(data, &m); err != nil {
				return
			}
			c.mu.Lock()
			h := c.handler
			c.mu.Unlock()
			if h != nil {
				h(m)
				continue
			}
			c.msgs <- m
		}
	}()
	return c, nil
}

func (c *sigClient) send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.conn.WriteMessage(websocket.TextMessage, b)
}

func (c *sigClient) setHandler(h func(sigMsg)) {
	c.mu.Lock()
	c.handler = h
	c.mu.Unlock()
}

func (c *sigClient) close() {
	c.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(1000, ""))
	c.conn.Close()
}

// wait returns the next message of the wanted type, keeping others for later.
func (c *sigClient) wait(want string, timeout time.Duration) (sigMsg, error) {
	deadline := time.After(timeout)
	for {
		if len(c.seen) > 0 {
			for i, m := range c.seen {
				if want == "" || m.T == want {
					c.seen = append(c.seen[:i], c.seen[i+1:]...)
					return m, nil
				}
			}
		}
		select {
		case m, ok := <-c.msgs:
			if !ok {
				return sigMsg{}, errors.New("connection closed")
			}
			if want == "" || m.T == want {
				return m, nil
			}
			c.seen = append(c.seen, m)
		case <-deadline:
			return sigMsg{}, fmt.Errorf("timeout waiting for %q", want)
		}
	}
}

func (c *sigClient) drain(d time.Duration) []sigMsg {
	out := append([]sigMsg{}, c.seen...)
	c.seen = nil
	deadline := time.After(d)
	for {
		select {
		case m, ok := <-c.msgs:
			if !ok {
				return out
			}
			out = append(out, m)
		case <-deadline:
			return out
		}
	}
}

type joinedPeer struct {
	c    *sigClient
	self string
	ice  []iceCfg
}

// join enters a room. It sends no passphrase, because the server has none to
// check: the room secret proves itself between the guests, in the sealed
// handshake, and a wrong one fails there and nowhere else.
func join(room string) (*joinedPeer, error) {
	c, err := dialSig()
	if err != nil {
		return nil, err
	}
	if err := c.send(map[string]any{"t": "join", "room": room}); err != nil {
		c.close()
		return nil, err
	}
	m, err := c.wait("", 5*time.Second)
	if err != nil {
		c.close()
		return nil, err
	}
	if m.T == "error" {
		c.close()
		return nil, fmt.Errorf("join rejected: %s", m.Code)
	}
	if m.T != "joined" {
		c.close()
		return nil, fmt.Errorf("expected joined, got %q", m.T)
	}
	c.self = m.Self
	// Relay credentials are not in the join any more: they are minted on
	// request, after a pair of this connection proved itself. A probe that
	// only needs a direct mesh asks for them here.
	ice, err := c.askIce("")
	if err != nil {
		c.close()
		return nil, err
	}
	c.ice = ice
	return &joinedPeer{c: c, self: m.Self, ice: ice}, nil
}

// askIce asks the server for relay credentials and waits for the answer. An
// error reply comes back as an error, so a probe says why it has no relay.
func (c *sigClient) askIce(to string) ([]iceCfg, error) {
	req := map[string]any{"t": "ice"}
	if to != "" {
		req["to"] = to
	}
	if err := c.send(req); err != nil {
		return nil, err
	}
	m, err := c.wait("", 5*time.Second)
	if err != nil {
		return nil, err
	}
	if m.T == "error" {
		return nil, fmt.Errorf("ice rejected: %s", m.Code)
	}
	if m.T != "ice" {
		return nil, fmt.Errorf("expected ice, got %q", m.T)
	}
	return m.Ice, nil
}

// ---------------------------------------------------------------- tests

func testHTTPSurface() {
	code, body, err := httpDo(http.MethodGet, "/", "")
	report("index page served with local client", errOr(err,
		code != 200, fmt.Sprintf("status %d", code),
		!bytes.Contains(body, []byte(`src="/app.js?v=`)), "no versioned app.js reference",
		!bytes.Contains(body, []byte(`href="/style.css?v=`)), "no versioned style.css reference",
		bytes.Contains(body, []byte("http://")), "external resource found"))

	for _, path := range []string{
		"/app.js", "/brand.js", "/style.css", "/favicon.svg",
		// The version query is ignored by the route and must still be served,
		// so a cache buster never costs a 404.
		"/app.js?v=test", "/style.css?v=test",
		"/sfx/lost.webm", "/sfx/lost.ogg", "/sfx/lost.mp3",
	} {
		code, _, err := httpDo(http.MethodGet, path, "")
		report("asset "+path, errOr(err, code != 200, fmt.Sprintf("status %d", code)))
	}

	// No route may list, count or describe rooms, and the retired paths of the
	// old sealed page are 404 like any other unknown path.
	leaks := 0
	paths := []string{
		"/rooms", "/api/rooms", "/api/rooms/list", "/rooms.json", "/metrics",
		"/debug", "/debug/pprof", "/debug/vars", "/status", "/stats", "/api",
		"/api/list", "/directory", "/room", "/.well-known/rooms", "/robots.txt",
		"/admin", "/healthz", "/e2e", "/e2e.html", "/e2e.js", "/e2e.css",
	}
	for _, p := range paths {
		code, body, err := httpDo(http.MethodGet, p, "")
		if err != nil {
			reportf("404 for "+p, "%v", err)
			continue
		}
		if code == http.StatusNotFound {
			continue
		}
		leaks++
		reportf("404 for "+p, "status %d body %q", code, strings.TrimSpace(string(body)))
	}
	if leaks == 0 {
		report(fmt.Sprintf("all %d non-UI paths return 404", len(paths)), nil)
	}

	// A room name must not be discoverable after the fact.
	room, err := randomRoomID()
	if err != nil {
		report("room id", err)
		return
	}
	found := false
	for _, p := range append(paths, "/api/rooms/"+room, "/room/"+room) {
		code, body, err := httpDo(http.MethodGet, p, "")
		if err != nil {
			continue
		}
		if bytes.Contains(body, []byte(room)) {
			found = true
			reportf("room id not exposed by GET "+p, "body contains the room id")
		}
		_ = code
	}
	if !found {
		report("room id never appears in any GET response", nil)
	}

	_ = code
}

func testUnauthorizedJoin() {
	// An id with characters outside the allowed set is refused, and nothing is
	// created. Any other name is a legit room name and is created by the join.
	malformed, err := rawJoinMessage("$bad/id")
	if err != nil {
		report("invalid room id rejected", err)
		return
	}
	if !strings.Contains(malformed, `"code":"unavailable"`) {
		report("invalid room id rejected", fmt.Errorf("unexpected answer %q", malformed))
	} else {
		report("invalid room id rejected with a generic error", nil)
	}

	// The room secret is not a server gate. A join that still carries a pass
	// field is an old client: the field is unknown now, so it is ignored and
	// the guest is let in. The sealed handshake is the only place where a
	// passphrase is judged, and it judges it between the guests.
	room, err := randomRoomID()
	if err != nil {
		report("legacy pass field is ignored", err)
		return
	}
	holder, err := join(room)
	if err != nil {
		report("legacy pass field is ignored", err)
		return
	}
	defer holder.c.close()
	legacy, err := rawJoinMessageFields(map[string]any{"t": "join", "room": room, "pass": "anything"})
	if err != nil {
		report("legacy pass field is ignored", err)
		return
	}
	report("a legacy pass field is ignored, not refused", errOr(nil,
		strings.Contains(legacy, `"code":"unavailable"`), fmt.Sprintf("unexpected answer %q", legacy)))
	report("the join answer does not echo the pass value", errOr(nil,
		strings.Contains(legacy, "anything"), "the answer carries the pass value"))

	// Every failure mode of a join must look the same, including a full room.
	// That is covered by the cap test as well, but check the shape here.
	report("join errors carry no room state", errOr(nil,
		strings.Contains(malformed, "room") && !strings.Contains(malformed, `"room":`),
		"error mentions the room id"))

	// A well formed id that nobody made yet is created by the first join.
	id, err := randomRoomID()
	if err != nil {
		report("join creates a missing room", err)
		return
	}
	a, err := join(id)
	if err != nil {
		report("join creates a missing room", err)
		return
	}
	defer a.c.close()
	report("join creates a missing room", nil)

	b, err := join(id)
	if err != nil {
		report("second peer joins the created room", err)
		return
	}
	defer b.c.close()
	report("second peer joins the created room", nil)

	m, err := a.c.wait("peer-joined", 3*time.Second)
	report("created room announces the second peer", errOr(err,
		m.Peer == nil || m.Peer.ID != b.self, "wrong peer id"))
}

// randomRoomID builds a room id in the same shape the server uses, without
// asking the server to create one.
func randomRoomID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return b32Lower.EncodeToString(b), nil
}

// rawJoinMessage sends one join on a bare connection and returns the raw reply.
func rawJoinMessage(room string) (string, error) {
	return rawJoinMessageFields(map[string]any{"t": "join", "room": room})
}

// rawJoinMessageFields sends an arbitrary join frame, so a test can prove that
// a field the server no longer knows is ignored instead of refused.
func rawJoinMessageFields(fields map[string]any) (string, error) {
	endpoint, err := wsEndpoint()
	if err != nil {
		return "", err
	}
	conn, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	payload, _ := json.Marshal(fields)
	if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		return "", err
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func testHardening() {
	// A message above the read limit must terminate the connection.
	endpoint, err := wsEndpoint()
	if err != nil {
		report("oversized message rejected", err)
		return
	}
	conn, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		report("oversized message rejected", err)
		return
	}
	defer conn.Close()
	big := bytes.Repeat([]byte("a"), 300*1024)
	conn.WriteMessage(websocket.TextMessage, big)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, _, err = conn.ReadMessage()
	report("oversized message closes the connection", errOr(nil, err == nil, "connection stayed open"))

	// Relaying before joining must not be possible.
	conn2, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		report("relay before join rejected", err)
		return
	}
	defer conn2.Close()
	conn2.WriteMessage(websocket.TextMessage, []byte(`{"t":"offer","to":"deadbeef","sdp":"v=0"}`))
	conn2.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := conn2.ReadMessage()
	report("relay before join rejected", errOr(err,
		!strings.Contains(string(data), `"code":"unavailable"`), "unexpected reply "+string(data)))
}

func testRelay() {
	room, err := randomRoomID()
	if err != nil {
		report("relay room", err)
		return
	}
	a, err := join(room)
	if err != nil {
		report("peer A joins", err)
		return
	}
	defer a.c.close()

	b, err := join(room)
	if err != nil {
		report("peer B joins", err)
		return
	}
	defer b.c.close()

	m, err := a.c.wait("peer-joined", 3*time.Second)
	report("peer-joined reaches A", errOr(err, m.Peer == nil || m.Peer.ID != b.self, "wrong peer id"))

	// A clear description is refused at the sender and never reaches the peer.
	clear := map[string]any{"t": "offer", "to": a.self, "sdp": "v=0\r\ns=probe-offer\r\n"}
	if err := b.c.send(clear); err != nil {
		report("clear offer refused at the sender", err)
		return
	}
	got, err := b.c.wait("error", 3*time.Second)
	report("clear offer refused at the sender", errOr(err,
		got.Code != "sealed-only", "code "+got.Code))
	if extra := a.c.drain(400 * time.Millisecond); len(extra) > 0 {
		report("clear offer never reaches the peer", fmt.Errorf("%d messages reached the peer", len(extra)))
	} else {
		report("clear offer never reaches the peer", nil)
	}

	// The same description inside an enc frame does reach the peer, untouched.
	sdp := "v=0\r\ns=probe-offer\r\n"
	if err := sendSealed(b.c, a.self, sigMsg{T: "offer", SDP: sdp}); err != nil {
		report("sealed offer relayed to A", err)
		return
	}
	got, err = a.c.wait("enc", 3*time.Second)
	sealed, ok := readSealed(got)
	report("sealed offer relayed to A", errOr(err,
		got.From != b.self, "from "+got.From,
		!ok, "payload did not decode",
		sealed.SDP != sdp, "sdp changed"))

	// Peer left notification.
	b.c.close()
	m, err = a.c.wait("peer-left", 5*time.Second)
	report("peer-left reaches A", errOr(err, m.From != b.self, "wrong peer id"))
}

// silent proves that no frame of one type arrives: the server answers some old
// frames with nothing at all, and a stray echo would be a leak.
func silent(c *sigClient, kind string, d time.Duration) error {
	if m, err := c.wait(kind, d); err == nil {
		return fmt.Errorf("a %s frame arrived from %s", kind, m.From)
	}
	return nil
}

// testTogglesBlind checks that the toggle flags no longer travel through the
// server: a clear state frame is dropped without an echo and reaches no peer, a
// lowerhand command does nothing, and no peer list carries a toggle field. The
// sealed copies of the flags are the guests' own business.
func testTogglesBlind() {
	room, err := randomRoomID()
	if err != nil {
		report("toggles: room", err)
		return
	}
	a, err := join(room)
	if err != nil {
		report("toggles: peer A joins", err)
		return
	}
	defer a.c.close()
	b, err := join(room)
	if err != nil {
		report("toggles: peer B joins", err)
		return
	}
	defer b.c.close()
	a.c.drain(200 * time.Millisecond)
	b.c.drain(200 * time.Millisecond)

	// An old client still sends its flags in the clear. The server accepts the
	// frame and keeps none of it: no guest sees it and the sender gets no echo.
	if err := b.c.send(map[string]any{
		"t": "state", "mic": false, "cam": false, "deaf": true, "screen": true, "hand": true,
	}); err != nil {
		report("toggles: an old clear state is accepted", err)
		return
	}
	report("toggles: a clear state reaches no guest", silent(a.c, "state", 700*time.Millisecond))
	report("toggles: a clear state is not echoed", silent(b.c, "state", 500*time.Millisecond))

	// The same flags travel sealed, as one opaque blob per pair. The relay must
	// carry it verbatim and must not read it.
	sealed, _ := json.Marshal(map[string]any{
		"k": "state", "mic": false, "cam": false, "deaf": true, "hand": true, "ts": 1700000000000,
	})
	blob := base64.StdEncoding.EncodeToString(sealed)
	if err := b.c.send(map[string]any{"t": "enc", "to": a.self, "b": blob}); err != nil {
		report("toggles: the sealed copy reaches the pair", err)
		return
	}
	m, err := a.c.wait("enc", 3*time.Second)
	report("toggles: the sealed copy reaches the pair", errOr(err,
		m.From != b.self, "wrong sender",
		m.B != blob, "the blob changed on the way"))

	// An old host command that used to clear a queue from the server side is
	// gone with the queue numbers: it must not produce a frame either.
	a.c.send(map[string]any{"t": "mod", "to": b.self, "action": "lowerhand"})
	report("toggles: a lowerhand command makes no frame", silent(b.c, "state", 500*time.Millisecond))

	// The peer lists are where the flags used to ride along. Neither a first
	// nor a second join may name a toggle.
	first, err := rawJoinMessage(room)
	if err != nil {
		report("toggles: the first join reply", err)
		return
	}
	report("toggles: the first join reply carries no toggle", errOr(nil,
		strings.Contains(first, `"mic"`), "a mic field",
		strings.Contains(first, `"cam"`), "a cam field",
		strings.Contains(first, `"deaf"`), "a deaf field",
		strings.Contains(first, `"hand"`), "a hand field"))
	second, err := rawJoinMessage(room)
	if err != nil {
		report("toggles: the second join reply", err)
		return
	}
	report("toggles: the peer list carries no toggle", errOr(nil,
		strings.Contains(second, `"mic"`), "a mic field",
		strings.Contains(second, `"cam"`), "a cam field",
		strings.Contains(second, `"deaf"`), "a deaf field",
		strings.Contains(second, `"hand"`), "a hand field"))
}

// testNoNameInJoin checks that the room protocol never carries a name: the
// server announces a peer by one opaque id, and a name sent by an old client is
// ignored rather than stored or echoed.
func testNoNameInJoin() {
	room, err := randomRoomID()
	if err != nil {
		report("no name: room", err)
		return
	}
	if first, err := rawJoinMessage(room); err != nil {
		report("no name: first join", err)
		return
	} else if strings.Contains(first, `"name"`) || strings.Contains(first, `"sealed"`) {
		report("no name: first join", fmt.Errorf("reply carries a name or a mode flag: %s", first))
		return
	}
	second, err := rawJoinMessage(room)
	if err != nil {
		report("no name: second join", err)
		return
	}
	report("a join carries no name and no mode flag", errOr(nil,
		strings.Contains(second, `"name"`), "the peer list carries a name",
		strings.Contains(second, `"sealed"`), "the peer list carries a mode flag"))
}

func testRoomIsolation() {
	room1, _ := randomRoomID()
	room2, _ := randomRoomID()
	a, err := join(room1)
	if err != nil {
		report("isolation: A joins", err)
		return
	}
	defer a.c.close()
	d, err := join(room2)
	if err != nil {
		report("isolation: D joins", err)
		return
	}
	defer d.c.close()

	// A tries to reach D across rooms: nothing may arrive.
	a.c.send(map[string]any{"t": "enc", "to": d.self, "b": "AAAA"})
	a.c.send(map[string]any{"t": "enc", "to": "*", "b": "AAAA"})

	leaked := d.c.drain(700 * time.Millisecond)
	report("cross-room sealed payload dropped", errOr(nil, len(leaked) != 0, fmt.Sprintf("%d messages leaked", len(leaked))))

	// A cannot learn anything about other rooms either.
	m, err := a.c.wait("", 100*time.Millisecond)
	report("no room information pushed to peers", errOr(nil, err == nil, "unexpected message "+m.T))
}

// testNoRoomControl proves the clear room control is gone from the server: a
// join names nobody, the knock carries one opaque id, and a clear role, mute,
// kick or admit command makes no frame at all. The role list, the waiting room,
// the kick and the mute are sealed notices between the guests now.
func testNoRoomControl() {
	room, _ := randomRoomID()
	a, err := join(room)
	if err != nil {
		report("room control: A joins", err)
		return
	}
	defer a.c.close()

	first, err := rawJoinMessage(room)
	if err != nil {
		report("room control: the first join reply", err)
		return
	}
	report("a join carries no roster, no role and no waiting flag", errOr(nil,
		strings.Contains(first, `"peers"`), "a roster",
		strings.Contains(first, `"admins"`), "a role list",
		strings.Contains(first, `"waiting"`), "a waiting flag",
		strings.Contains(first, `"waitingRoom"`), "a waiting switch"))

	// The raw joins above are over: their knocks and leaves are not the news
	// this test looks at.
	a.c.drain(400 * time.Millisecond)

	b, err := join(room)
	if err != nil {
		report("room control: B joins", err)
		return
	}
	defer b.c.close()

	pm, err := a.c.wait("peer-joined", 2*time.Second)
	report("a knock names the new peer and nothing else", errOr(err,
		pm.Peer == nil || pm.Peer.ID != b.self, "the knock carries the wrong id"))

	// Every clear command the server used to obey is dropped without a word.
	for _, cmd := range []map[string]any{
		{"t": "mod", "action": "waitingroom", "on": true},
		{"t": "mod", "to": b.self, "action": "admin"},
		{"t": "mod", "to": b.self, "action": "mute"},
		{"t": "mod", "to": b.self, "action": "kick"},
		{"t": "admit", "to": b.self},
	} {
		if err := b.c.send(cmd); err != nil {
			report("room control: a clear command is sent", err)
			return
		}
		if got := b.c.drain(250 * time.Millisecond); len(got) != 0 {
			report("a clear command makes no frame", fmt.Errorf("%v produced %q", cmd, got[0].T))
			return
		}
	}
	report("a clear role, mute, kick or admit command makes no frame", nil)

	// The socket is still a blind relay after those commands.
	if err := a.c.send(map[string]any{"t": "enc", "to": b.self, "b": `"AAAA"`}); err != nil {
		report("room control: the relay still carries a payload", err)
		return
	}
	m, err := b.c.wait("enc", 2*time.Second)
	report("the relay still carries a payload after a clear command", errOr(err, m.From != a.self, "wrong sender"))
}

// testRoomLifetime proves a room is gone as soon as its last peer leaves: the
// same id joins again as a new room, with a new first guest and no admin left
// over from the old one.
func testRoomLifetime() {
	room, err := randomRoomID()
	if err != nil {
		report("lifetime: room", err)
		return
	}
	a, err := join(room)
	if err != nil {
		report("lifetime: first peer joins", err)
		return
	}
	a.c.close()

	// The close is handled in another goroutine on the server, so the join is
	// retried: the first accepted one is the join of the new room.
	var b *joinedPeer
	deadline := time.Now().Add(3 * time.Second)
	for {
		b, err = join(room)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			reportf("last leave drops the room", "room still there after 3 s: %v", err)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	defer b.c.close()
	report("last leave drops the room", nil)

	// The new room has one guest and a fresh id, so nothing of the old room
	// survives it.
	report("the new room starts with a new first guest", errOr(nil,
		b.self == a.self, "the new room reused the old peer id"))
}

func testLimits() {
	room, err := randomRoomID()
	if err != nil {
		report("limits: room", err)
		return
	}
	var peers []*joinedPeer
	defer func() {
		for _, p := range peers {
			p.c.close()
		}
	}()
	rejected := 0
	for i := 0; i < 12; i++ {
		p, err := join(room)
		if err != nil {
			if strings.Contains(err.Error(), "unavailable") {
				rejected++
			}
			break
		}
		peers = append(peers, p)
	}
	report(fmt.Sprintf("room cap enforced after %d peers", len(peers)), peersNote(len(peers), rejected))
}

func peersNote(joined, rejected int) error {
	if joined < 2 {
		return fmt.Errorf("only %d peers joined", joined)
	}
	if rejected == 0 {
		return errors.New("no peer was rejected, cap not enforced")
	}
	return nil
}

// ---------------------------------------------------------------- webrtc

// sendSealed puts one description or candidate inside an enc frame, which the
// server forwards without looking. readSealed is the other end.
func sendSealed(c *sigClient, to string, body sigMsg) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return c.send(map[string]any{"t": "enc", "to": to, "b": base64.StdEncoding.EncodeToString(raw)})
}

func readSealed(m sigMsg) (sigMsg, bool) {
	if m.T != "enc" || m.B == "" {
		return sigMsg{}, false
	}
	raw, err := base64.StdEncoding.DecodeString(m.B)
	if err != nil {
		return sigMsg{}, false
	}
	var body sigMsg
	if json.Unmarshal(raw, &body) != nil {
		return sigMsg{}, false
	}
	return body, true
}

type rtcPair struct {
	a, b    *webrtc.PeerConnection
	dc      *webrtc.DataChannel
	dcOpen  chan struct{}
	trackCh chan string
	packets atomic.Int64
	closeup func()
}

func newPair(conf webrtc.Configuration, sigA, sigB *sigClient, aSelf, bSelf string) (*rtcPair, error) {
	a, err := webrtc.NewPeerConnection(conf)
	if err != nil {
		return nil, err
	}
	b, err := webrtc.NewPeerConnection(conf)
	if err != nil {
		a.Close()
		return nil, err
	}
	p := &rtcPair{a: a, b: b, dcOpen: make(chan struct{}), trackCh: make(chan string, 4)}

	wire := func(pc *webrtc.PeerConnection, sig *sigClient, remote string) {
		pc.OnICECandidate(func(c *webrtc.ICECandidate) {
			if c == nil {
				return
			}
			raw, err := json.Marshal(c.ToJSON())
			if err == nil {
				sendSealed(sig, remote, sigMsg{T: "ice", Candidate: raw})
			}
		})
		sig.setHandler(func(m sigMsg) {
			body, ok := readSealed(m)
			if !ok {
				return
			}
			switch body.T {
			case "offer":
				if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: body.SDP}); err != nil {
					return
				}
				ans, err := pc.CreateAnswer(nil)
				if err != nil {
					return
				}
				if err := pc.SetLocalDescription(ans); err != nil {
					return
				}
				sendSealed(sig, m.From, sigMsg{T: "answer", SDP: pc.LocalDescription().SDP})
			case "answer":
				pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: body.SDP})
			case "ice":
				var c webrtc.ICECandidateInit
				if err := json.Unmarshal(body.Candidate, &c); err == nil {
					pc.AddICECandidate(c)
				}
			}
		})
	}
	wire(a, sigA, bSelf)
	wire(b, sigB, aSelf)

	dc, err := a.CreateDataChannel("probe", nil)
	if err != nil {
		p.Close()
		return nil, err
	}
	p.dc = dc
	var openOnce sync.Once
	dc.OnOpen(func() { openOnce.Do(func() { close(p.dcOpen) }) })

	b.OnDataChannel(func(remote *webrtc.DataChannel) {
		remote.OnMessage(func(msg webrtc.DataChannelMessage) {
			remote.Send([]byte("echo:" + string(msg.Data)))
		})
	})
	b.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		select {
		case p.trackCh <- tr.Codec().MimeType:
		default:
		}
		for {
			if _, _, err := tr.ReadRTP(); err != nil {
				return
			}
			p.packets.Add(1)
		}
	})

	p.closeup = func() { a.Close(); b.Close() }
	return p, nil
}

func (p *rtcPair) Close() {
	if p.closeup != nil {
		p.closeup()
	}
}

// runMesh brings up one direction: A offers, B answers, A sends a data channel
// message and an Opus track; B echoes and receives.
func runMesh(p *rtcPair, sigA *sigClient, bSelf string, timeout time.Duration) error {
	audio, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio", "probe")
	if err != nil {
		return err
	}
	if _, err := p.a.AddTrack(audio); err != nil {
		return err
	}

	offer, err := p.a.CreateOffer(nil)
	if err != nil {
		return err
	}
	if err := p.a.SetLocalDescription(offer); err != nil {
		return err
	}
	if err := sendSealed(sigA, bSelf, sigMsg{T: "offer", SDP: p.a.LocalDescription().SDP}); err != nil {
		return err
	}

	stopAudio := make(chan struct{})
	defer close(stopAudio)
	go func() {
		payload := make([]byte, 240)
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stopAudio:
				return
			case <-tick.C:
				audio.WriteSample(media.Sample{Data: payload, Duration: 20 * time.Millisecond})
			}
		}
	}()

	select {
	case <-p.dcOpen:
	case <-time.After(timeout):
		return errors.New("data channel did not open")
	}

	dc := p.dc
	got := make(chan string, 1)
	dc.OnMessage(func(m webrtc.DataChannelMessage) { got <- string(m.Data) })
	dc.SendText("hello")

	select {
	case msg := <-got:
		if msg != "echo:hello" {
			return fmt.Errorf("data channel echo wrong: %q", msg)
		}
	case <-time.After(timeout):
		return errors.New("no data channel echo")
	}

	select {
	case codec := <-p.trackCh:
		if !strings.EqualFold(codec, webrtc.MimeTypeOpus) {
			return fmt.Errorf("unexpected codec %q", codec)
		}
	case <-time.After(timeout):
		return errors.New("no audio track received")
	}

	deadline := time.Now().Add(timeout)
	for p.packets.Load() < 5 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if p.packets.Load() < 5 {
		return fmt.Errorf("only %d audio packets received", p.packets.Load())
	}
	return nil
}

func selectedPairType(pc *webrtc.PeerConnection) (string, error) {
	transport := pc.SCTP()
	if transport == nil {
		return "", errors.New("no sctp transport")
	}
	dtls := transport.Transport()
	if dtls == nil {
		return "", errors.New("no dtls transport")
	}
	ice := dtls.ICETransport()
	if ice == nil {
		return "", errors.New("no ice transport")
	}
	pair, err := ice.GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil {
		return "", errors.New("no selected candidate pair")
	}
	return pair.Local.Typ.String(), nil
}

func iceFromServer(ice []iceCfg) webrtc.Configuration {
	conf := webrtc.Configuration{}
	for _, s := range ice {
		conf.ICEServers = append(conf.ICEServers, webrtc.ICEServer{
			URLs:       s.URLs,
			Username:   s.Username,
			Credential: s.Credential,
		})
	}
	return conf
}

func testWebRTCMesh() {
	room, err := randomRoomID()
	if err != nil {
		report("webrtc: room", err)
		return
	}
	a, err := join(room)
	if err != nil {
		report("webrtc: A joins", err)
		return
	}
	defer a.c.close()
	b, err := join(room)
	if err != nil {
		report("webrtc: B joins", err)
		return
	}
	defer b.c.close()
	a.c.wait("peer-joined", 3*time.Second)

	// A relay credential is minted for a pair, so B asks for one naming A and
	// both halves of the mesh use the same relay.
	relay, err := b.c.askIce(a.self)
	if err != nil {
		report("turn credentials issued on request", err)
		return
	}
	turnFound := false
	for _, s := range relay {
		for _, u := range s.URLs {
			if strings.HasPrefix(u, "turn:") {
				turnFound = true
				if s.Username == "" || s.Credential == "" {
					report("turn credentials issued on request", errors.New("turn url without ephemeral credential"))
				}
			}
		}
	}
	if turnFound {
		report("turn credentials issued on request", nil)
	} else {
		report("turn credentials issued on request", errors.New("no turn: url in the ice list (server started without TURN?)"))
	}
	conf := iceFromServer(relay)

	p, err := newPair(conf, a.c, b.c, a.self, b.self)
	if err != nil {
		report("webrtc: peer connections", err)
		return
	}
	defer p.Close()

	err = runMesh(p, a.c, b.self, 20*time.Second)
	report("direct p2p: data channel, opus audio, echo", err)
	if err == nil {
		kind, kerr := selectedPairType(p.a)
		if kerr == nil {
			fmt.Printf("      selected candidate pair: %s\n", kind)
		}
	}
}

func testTURNRelay() {
	room, err := randomRoomID()
	if err != nil {
		report("relay: room", err)
		return
	}
	a, err := join(room)
	if err != nil {
		report("relay: A joins", err)
		return
	}
	defer a.c.close()
	b, err := join(room)
	if err != nil {
		report("relay: B joins", err)
		return
	}
	defer b.c.close()
	a.c.wait("peer-joined", 3*time.Second)

	relay, err := b.c.askIce(a.self)
	if err != nil {
		report("relay-only p2p through embedded turn", err)
		return
	}
	conf := iceFromServer(relay)
	if len(conf.ICEServers) == 0 {
		report("relay-only p2p through embedded turn", errors.New("no ice servers"))
		return
	}
	// Force every candidate through the TURN relay: this is the fallback path.
	conf.ICETransportPolicy = webrtc.ICETransportPolicyRelay

	p, err := newPair(conf, a.c, b.c, a.self, b.self)
	if err != nil {
		report("relay: peer connections", err)
		return
	}
	defer p.Close()

	err = runMesh(p, a.c, b.self, 30*time.Second)
	report("relay-only p2p through embedded turn", err)
	if err == nil {
		kind, kerr := selectedPairType(p.a)
		if kerr != nil {
			report("relay pair is actually relayed", kerr)
		} else {
			report("relay pair is actually relayed", errOr(nil, kind != "relay", "selected pair is "+kind))
		}
	}
}

// ---------------------------------------------------------------- helpers

func errOr(err error, conds ...any) error {
	if err != nil {
		return err
	}
	for i := 0; i+1 < len(conds); i += 2 {
		cond, ok := conds[i].(bool)
		if !ok {
			continue
		}
		if cond {
			return fmt.Errorf("%v", conds[i+1])
		}
	}
	return nil
}

func main() {
	addr := flag.String("addr", "http://127.0.0.1:8095", "base URL of the running server")
	flag.Parse()

	baseURL = strings.TrimRight(*addr, "/")
	httpBase = baseURL
	if !strings.HasPrefix(httpBase, "http") {
		report("address", errors.New("address must start with http:// or https://"))
		os.Exit(2)
	}

	fmt.Printf("target %s\n\n", httpBase)

	code, _, err := httpDo(http.MethodGet, "/", "")
	if err != nil || code != 200 {
		fmt.Printf("server not reachable: %v (status %d)\n", err, code)
		os.Exit(2)
	}

	testHTTPSurface()
	fmt.Println()
	testUnauthorizedJoin()
	testRelay()
	testHardening()
	testRoomIsolation()
	testNoRoomControl()
	testTogglesBlind()
	testNoNameInJoin()
	testLimits()
	testRoomLifetime()
	fmt.Println()
	testWebRTCMesh()
	fmt.Println()
	testTURNRelay()

	fmt.Printf("\n%d checks, %d failed\n", checks, failures)
	if failures > 0 {
		os.Exit(1)
	}
	fmt.Println("RESULT: PASS")
}
