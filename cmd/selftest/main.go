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

func createRoom(pass string) (string, error) {
	payload, _ := json.Marshal(map[string]string{"pass": pass})
	code, body, err := httpDo(http.MethodPost, "/api/new", string(payload))
	if err != nil {
		return "", err
	}
	if code != http.StatusOK {
		return "", fmt.Errorf("create room: status %d: %s", code, body)
	}
	var out struct {
		Room string `json:"room"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	if len(out.Room) != 26 {
		return "", fmt.Errorf("room id %q does not look like 128 bit base32", out.Room)
	}
	return out.Room, nil
}

// ---------------------------------------------------------------- signaling

type peerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
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

func join(room, pass, name string) (*joinedPeer, error) {
	c, err := dialSig()
	if err != nil {
		return nil, err
	}
	if err := c.send(map[string]any{"t": "join", "room": room, "pass": pass, "name": name}); err != nil {
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

	// No route may list, count or describe rooms.
	leaks := 0
	paths := []string{
		"/rooms", "/api/rooms", "/api/rooms/list", "/rooms.json", "/metrics",
		"/debug", "/debug/pprof", "/debug/vars", "/status", "/stats", "/api",
		"/api/list", "/directory", "/room", "/.well-known/rooms", "/robots.txt",
		"/admin", "/healthz",
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

	// A created room must not be discoverable after the fact.
	room, err := createRoom("")
	if err != nil {
		report("room creation", err)
		return
	}
	report("room creation", nil)
	found := false
	for _, p := range append(paths, "/api/new", "/api/rooms/"+room, "/room/"+room) {
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

	code, _, err = httpDo(http.MethodGet, "/api/new", "")
	report("GET /api/new rejected", errOr(err, code != http.StatusMethodNotAllowed, fmt.Sprintf("status %d", code)))
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
	room, err := createRoom("secret")
	if err != nil {
		report("wrong passphrase rejected", err)
		return
	}
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
	a, err := join(id, "open-sesame", "alice")
	if err != nil {
		report("join creates a missing room", err)
		return
	}
	defer a.c.close()
	report("join creates a missing room", nil)

	b, err := join(id, "open-sesame", "bob")
	if err != nil {
		report("second peer joins the created room", err)
		return
	}
	defer b.c.close()
	report("second peer joins the created room", nil)

	m, err := a.c.wait("peer-joined", 3*time.Second)
	report("created room announces the second peer", errOr(err,
		m.Peer == nil || m.Peer.ID != b.self, "wrong peer id"))

	if _, err := join(id, "", "carol"); err == nil {
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
	payload, _ := json.Marshal(map[string]any{"t": "join", "room": room, "pass": pass, "name": "probe"})
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
	room, err := createRoom("")
	if err != nil {
		report("relay room", err)
		return
	}
	a, err := join(room, "", "alice")
	if err != nil {
		report("peer A joins", err)
		return
	}
	defer a.c.close()

	b, err := join(room, "", "bob")
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

func testRoomIsolation() {
	room1, _ := createRoom("")
	room2, _ := createRoom("")
	a, err := join(room1, "", "a")
	if err != nil {
		report("isolation: A joins", err)
		return
	}
	defer a.c.close()
	d, err := join(room2, "", "d")
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

func testLimits() {
	room, err := createRoom("")
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
		p, err := join(room, "", fmt.Sprintf("p%d", i))
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
	room, err := createRoom("")
	if err != nil {
		report("webrtc: room", err)
		return
	}
	a, err := join(room, "", "alice")
	if err != nil {
		report("webrtc: A joins", err)
		return
	}
	defer a.c.close()
	b, err := join(room, "", "bob")
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
	room, err := createRoom("")
	if err != nil {
		report("relay: room", err)
		return
	}
	a, err := join(room, "", "alice")
	if err != nil {
		report("relay: A joins", err)
		return
	}
	defer a.c.close()
	b, err := join(room, "", "bob")
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
	testLimits()
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
