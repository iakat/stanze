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
	ID      string `json:"id"`
	Waiting bool   `json:"waiting"`
	Hand    bool   `json:"hand"`
	HandSeq int    `json:"handSeq"`
}

type iceCfg struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

type sigMsg struct {
	T         string          `json:"t"`
	Self      string          `json:"self"`
	Peers     []peerInfo      `json:"peers"`
	Peer      *peerInfo       `json:"peer"`
	From      string          `json:"from"`
	SDP       string          `json:"sdp"`
	Candidate json.RawMessage `json:"candidate"`
	Code      string          `json:"code"`
	Ice       []iceCfg        `json:"ice"`

	Waiting     bool  `json:"waiting"`
	WaitingRoom *bool `json:"waitingRoom"`
	Hand        *bool `json:"hand"`
	HandSeq     int   `json:"handSeq"`
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

func join(room, pass string) (*joinedPeer, error) {
	c, err := dialSig()
	if err != nil {
		return nil, err
	}
	if err := c.send(map[string]any{"t": "join", "room": room, "pass": pass}); err != nil {
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
	c.ice = m.Ice
	return &joinedPeer{c: c, self: m.Self, ice: m.Ice}, nil
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
		"/app.js", "/style.css", "/favicon.svg",
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
	malformed, err := rawJoinMessage("$bad/id", "")
	if err != nil {
		report("invalid room id rejected", err)
		return
	}
	if !strings.Contains(malformed, `"code":"unavailable"`) {
		report("invalid room id rejected", fmt.Errorf("unexpected answer %q", malformed))
	} else {
		report("invalid room id rejected with a generic error", nil)
	}

	// Wrong passphrase on a real room must produce a byte identical answer.
	// The first join sets the passphrase, so a holder peer keeps it alive.
	room, err := randomRoomID()
	if err != nil {
		report("wrong passphrase rejected", err)
		return
	}
	holder, err := join(room, "secret")
	if err != nil {
		report("wrong passphrase rejected", err)
		return
	}
	defer holder.c.close()
	wrongPass, err := rawJoinMessage(room, "nope")
	if err != nil {
		report("wrong passphrase rejected", err)
		return
	}
	if !strings.Contains(wrongPass, `"code":"unavailable"`) {
		report("wrong passphrase rejected", fmt.Errorf("unexpected answer %q", wrongPass))
	} else {
		report("wrong passphrase rejected with a generic error", nil)
	}
	report("invalid id and wrong passphrase are byte identical", errOr(nil,
		malformed != wrongPass, fmt.Sprintf("%q vs %q", malformed, wrongPass)))

	// Every failure mode of a join must look the same, including a full room.
	// That is covered by the cap test as well, but check the shape here.
	report("join errors carry no room state", errOr(nil,
		strings.Contains(malformed, "room") && !strings.Contains(malformed, `"room":`),
		"error mentions the room id"))

	// A well formed id that nobody made yet is created by the first join, and
	// the passphrase of that join becomes the room passphrase.
	id, err := randomRoomID()
	if err != nil {
		report("join creates a missing room", err)
		return
	}
	a, err := join(id, "open-sesame")
	if err != nil {
		report("join creates a missing room", err)
		return
	}
	defer a.c.close()
	report("join creates a missing room", nil)

	b, err := join(id, "open-sesame")
	if err != nil {
		report("second peer joins the created room", err)
		return
	}
	defer b.c.close()
	report("second peer joins the created room", nil)

	m, err := a.c.wait("peer-joined", 3*time.Second)
	report("created room announces the second peer", errOr(err,
		m.Peer == nil || m.Peer.ID != b.self, "wrong peer id"))

	if _, err := join(id, ""); err == nil {
		report("created room keeps its passphrase", errors.New("join without passphrase accepted"))
	} else {
		report("created room keeps its passphrase", nil)
	}
}

// randomRoomID builds a room id in the same shape the server uses, without
// asking the server to create one.
func randomRoomID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b)), nil
}

// rawJoinMessage sends one join on a bare connection and returns the raw reply.
func rawJoinMessage(room, pass string) (string, error) {
	endpoint, err := wsEndpoint()
	if err != nil {
		return "", err
	}
	conn, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	payload, _ := json.Marshal(map[string]any{"t": "join", "room": room, "pass": pass})
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
	a, err := join(room, "")
	if err != nil {
		report("peer A joins", err)
		return
	}
	defer a.c.close()

	b, err := join(room, "")
	if err != nil {
		report("peer B joins", err)
		return
	}
	defer b.c.close()

	m, err := a.c.wait("peer-joined", 3*time.Second)
	report("peer-joined reaches A", errOr(err, m.Peer == nil || m.Peer.ID != b.self, "wrong peer id"))

	offer := "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=probe-offer\r\n"
	answer := "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=probe-answer\r\n"
	cand := json.RawMessage(`{"candidate":"candidate:1 1 udp 1 127.0.0.1 5000 typ host","sdpMid":"0","sdpMLineIndex":0}`)

	if err := b.c.send(map[string]any{"t": "offer", "to": a.self, "sdp": offer}); err != nil {
		report("offer relayed to A", err)
		return
	}
	got, err := a.c.wait("offer", 3*time.Second)
	report("offer relayed to A verbatim", errOr(err,
		got.From != b.self, "from "+got.From,
		got.SDP != offer, "sdp changed"))

	if err := a.c.send(map[string]any{"t": "answer", "to": b.self, "sdp": answer}); err != nil {
		report("answer relayed to B", err)
		return
	}
	got, err = b.c.wait("answer", 3*time.Second)
	report("answer relayed to B verbatim", errOr(err,
		got.From != a.self, "from "+got.From,
		got.SDP != answer, "sdp changed"))

	if err := b.c.send(map[string]any{"t": "ice", "to": a.self, "candidate": cand}); err != nil {
		report("ice candidate relayed", err)
		return
	}
	got, err = a.c.wait("ice", 3*time.Second)
	report("ice candidate relayed verbatim", errOr(err,
		got.From != b.self, "from "+got.From,
		string(got.Candidate) != string(cand), "candidate changed: "+string(got.Candidate)))

	// Peer left notification.
	b.c.close()
	m, err = a.c.wait("peer-left", 5*time.Second)
	report("peer-left reaches A", errOr(err, m.From != b.self, "wrong peer id"))
}

// testHandQueue checks the raised hand of a room: the flag reaches every guest
// with a queue number, a later raise takes a later number, a lowered hand gives
// its number back, and an admin can take a hand down.
func testHandQueue() {
	room, err := randomRoomID()
	if err != nil {
		report("hand: room", err)
		return
	}
	a, err := join(room, "")
	if err != nil {
		report("hand: peer A joins", err)
		return
	}
	defer a.c.close()
	b, err := join(room, "")
	if err != nil {
		report("hand: peer B joins", err)
		return
	}
	defer b.c.close()
	a.c.drain(300 * time.Millisecond)
	b.c.drain(100 * time.Millisecond)

	// nextState waits for the next state message of one peer.
	nextState := func(c *sigClient, from string) (sigMsg, error) {
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			m, err := c.wait("state", time.Until(deadline))
			if err != nil {
				return m, err
			}
			if m.From == from {
				return m, nil
			}
		}
		return sigMsg{}, errors.New("no state from " + from)
	}
	raise := func(c *sigClient, on bool) error {
		return c.send(map[string]any{"t": "state", "hand": on})
	}

	if err := raise(b.c, true); err != nil {
		report("hand: a raise reaches the room", err)
		return
	}
	m, err := nextState(a.c, b.self)
	first := m.HandSeq
	report("hand: a raise carries the hand and a queue number", errOr(err,
		m.Hand == nil || !*m.Hand, "hand flag not set",
		first < 1, fmt.Sprintf("queue number %d", first)))

	// The sender gets its own state too, with the same number: that echo is
	// where the client learns its place in the queue.
	m, err = nextState(b.c, b.self)
	report("hand: the sender learns its place", errOr(err,
		m.HandSeq != first, fmt.Sprintf("own echo %d, room saw %d", m.HandSeq, first)))

	if err := raise(a.c, true); err != nil {
		report("hand: a second raise reaches the room", err)
		return
	}
	m, err = nextState(b.c, a.self)
	second := m.HandSeq
	report("hand: a later raise takes a later place", errOr(err,
		second <= first, fmt.Sprintf("second raise %d after first %d", second, first)))

	if err := raise(a.c, false); err != nil {
		report("hand: a lowered hand reaches the room", err)
		return
	}
	m, err = nextState(b.c, a.self)
	report("hand: a lowered hand gives its number back", errOr(err,
		m.Hand != nil && *m.Hand, "hand still up",
		m.HandSeq != 0, fmt.Sprintf("queue number %d", m.HandSeq)))

	// A is the admin of the room. B raises again and A takes that hand down.
	if err := raise(b.c, true); err != nil {
		report("hand: a raise before the host lowers it", err)
		return
	}
	if _, err := nextState(a.c, b.self); err != nil {
		report("hand: the raise reaches the host", err)
		return
	}
	// The echo of that raise is on its way back to B as well; drop it, so the
	// next state of B is the answer to the host command.
	b.c.drain(200 * time.Millisecond)
	a.c.send(map[string]any{"t": "mod", "to": b.self, "action": "lowerhand"})
	m, err = nextState(b.c, b.self)
	report("hand: the host takes a hand down", errOr(err,
		m.Hand != nil && *m.Hand, "hand still up",
		m.HandSeq != 0, fmt.Sprintf("queue number %d", m.HandSeq)))

	// A guest who is not an admin can not take a hand down.
	if err := raise(b.c, true); err != nil {
		report("hand: a raise before the guest tries", err)
		return
	}
	if _, err := nextState(a.c, b.self); err != nil {
		report("hand: the raise reaches the room again", err)
		return
	}
	b.c.drain(200 * time.Millisecond)
	b.c.send(map[string]any{"t": "mod", "to": a.self, "action": "lowerhand"})
	if _, err := nextState(b.c, a.self); err == nil {
		report("hand: a guest who is no admin can not lower a hand", errors.New("the hand went down"))
	} else {
		report("hand: a guest who is no admin can not lower a hand", nil)
	}
}

// testNoNameInJoin checks that the room protocol never carries a name: the
// server announces peers by id and flags only, and a name sent by an old client
// is ignored rather than stored or echoed.
func testNoNameInJoin() {
	room, err := randomRoomID()
	if err != nil {
		report("no name: room", err)
		return
	}
	if first, err := rawJoinMessage(room, ""); err != nil {
		report("no name: first join", err)
		return
	} else if strings.Contains(first, `"name"`) || strings.Contains(first, `"sealed"`) {
		report("no name: first join", fmt.Errorf("reply carries a name or a mode flag: %s", first))
		return
	}
	second, err := rawJoinMessage(room, "")
	if err != nil {
		report("no name: second join", err)
		return
	}
	report("peer list carries no name and no mode flag", errOr(nil,
		strings.Contains(second, `"name"`), "the peer list carries a name",
		strings.Contains(second, `"sealed"`), "the peer list carries a mode flag"))
}

func testRoomIsolation() {
	room1, _ := randomRoomID()
	room2, _ := randomRoomID()
	a, err := join(room1, "")
	if err != nil {
		report("isolation: A joins", err)
		return
	}
	defer a.c.close()
	d, err := join(room2, "")
	if err != nil {
		report("isolation: D joins", err)
		return
	}
	defer d.c.close()

	// A tries to reach D across rooms: nothing may arrive.
	a.c.send(map[string]any{"t": "offer", "to": d.self, "sdp": "v=0\r\ns=x\r\n"})
	a.c.send(map[string]any{"t": "ice", "to": d.self, "candidate": json.RawMessage(`{"candidate":"x"}`)})

	leaked := d.c.drain(700 * time.Millisecond)
	report("cross-room offer dropped", errOr(nil, len(leaked) != 0, fmt.Sprintf("%d messages leaked", len(leaked))))

	// A cannot learn anything about other rooms either.
	m, err := a.c.wait("", 100*time.Millisecond)
	report("no room information pushed to peers", errOr(nil, err == nil, "unexpected message "+m.T))
}

// testWaitingRoom proves the waiting room on the wire: only the admin turns it
// on, a later guest waits, a waiting guest can not let anyone in, a member can,
// and everyone is told.
func testWaitingRoom() {
	room, _ := randomRoomID()
	a, err := join(room, "")
	if err != nil {
		report("waiting room: A joins", err)
		return
	}
	defer a.c.close()
	b, err := join(room, "")
	if err != nil {
		report("waiting room: B joins", err)
		return
	}
	defer b.c.close()
	a.c.drain(300 * time.Millisecond)
	b.c.drain(100 * time.Millisecond)

	on := true
	// B is no admin: the switch must not move.
	b.c.send(map[string]any{"t": "mod", "action": "waitingroom", "on": on})
	m, err := a.c.wait("waiting-room", 500*time.Millisecond)
	report("waiting room: a guest who is no admin can not switch it on", errOr(nil, err == nil, "the switch moved for "+m.T))

	a.c.send(map[string]any{"t": "mod", "action": "waitingroom", "on": on})
	m, err = b.c.wait("waiting-room", 2*time.Second)
	report("waiting room: the admin switches it on and the room is told", errOr(err, m.WaitingRoom == nil || !*m.WaitingRoom, "switch not true"))

	c, err := join(room, "")
	if err != nil {
		report("waiting room: C joins", err)
		return
	}
	defer c.c.close()
	pm, err := a.c.wait("peer-joined", 2*time.Second)
	report("waiting room: a later guest waits", errOr(err, pm.Peer == nil || !pm.Peer.Waiting, "peer-joined has no waiting flag"))

	// C waits, so C can not let anyone in, not even itself.
	c.c.send(map[string]any{"t": "admit", "to": c.self})
	_, err = a.c.wait("admitted", 500*time.Millisecond)
	report("waiting room: a waiting guest can not admit itself", errOr(nil, err == nil, "admitted"))

	b.c.send(map[string]any{"t": "admit", "to": c.self})
	am, err := a.c.wait("admitted", 2*time.Second)
	report("waiting room: a member lets the guest in", errOr(err, am.Peer == nil || am.Peer.ID != c.self, "wrong guest admitted"))
	_, err = c.c.wait("admitted", 2*time.Second)
	report("waiting room: the guest is told too", err)
}

// testRoomLifetime proves a room is gone as soon as its last peer leaves: the
// same id joins at once as a new room, so the old passphrase opens nothing.
func testRoomLifetime() {
	room, err := randomRoomID()
	if err != nil {
		report("lifetime: room", err)
		return
	}
	a, err := join(room, "first-pass")
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
		b, err = join(room, "second-pass")
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

	// The dropped room took its passphrase with it.
	if _, err := join(room, "first-pass"); err == nil {
		report("dropped room forgot its passphrase", errors.New("the old passphrase still opens the room"))
	} else {
		report("dropped room forgot its passphrase", nil)
	}
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
		p, err := join(room, "")
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
			sig.send(map[string]any{"t": "ice", "to": remote, "candidate": c.ToJSON()})
		})
		sig.setHandler(func(m sigMsg) {
			switch m.T {
			case "offer":
				if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: m.SDP}); err != nil {
					return
				}
				ans, err := pc.CreateAnswer(nil)
				if err != nil {
					return
				}
				if err := pc.SetLocalDescription(ans); err != nil {
					return
				}
				sig.send(map[string]any{"t": "answer", "to": m.From, "sdp": pc.LocalDescription().SDP})
			case "answer":
				pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: m.SDP})
			case "ice":
				var c webrtc.ICECandidateInit
				if err := json.Unmarshal(m.Candidate, &c); err == nil {
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
	if err := sigA.send(map[string]any{"t": "offer", "to": bSelf, "sdp": p.a.LocalDescription().SDP}); err != nil {
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
	a, err := join(room, "")
	if err != nil {
		report("webrtc: A joins", err)
		return
	}
	defer a.c.close()
	b, err := join(room, "")
	if err != nil {
		report("webrtc: B joins", err)
		return
	}
	defer b.c.close()
	a.c.wait("peer-joined", 3*time.Second)

	conf := iceFromServer(a.ice)
	turnFound := false
	for _, s := range a.ice {
		for _, u := range s.URLs {
			if strings.HasPrefix(u, "turn:") {
				turnFound = true
				if s.Username == "" || s.Credential == "" {
					report("turn credentials issued", errors.New("turn url without ephemeral credential"))
				}
			}
		}
	}
	if turnFound {
		report("turn credentials issued with the ice list", nil)
	} else {
		report("turn credentials issued with the ice list", errors.New("no turn: url in the ice list (server started without TURN?)"))
	}

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
	a, err := join(room, "")
	if err != nil {
		report("relay: A joins", err)
		return
	}
	defer a.c.close()
	b, err := join(room, "")
	if err != nil {
		report("relay: B joins", err)
		return
	}
	defer b.c.close()
	a.c.wait("peer-joined", 3*time.Second)

	conf := iceFromServer(a.ice)
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
	testWaitingRoom()
	testHandQueue()
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
