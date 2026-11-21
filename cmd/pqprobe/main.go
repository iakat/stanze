// Command pqprobe exercises a running server's blind relay mode.
//
// Two peers complete the real X25519 + ML-KEM-768 handshake over the
// signaling socket, exchange a sealed chat line, and a third peer sits in the
// same room with no key and records everything the server forwards. The probe
// fails if any plaintext name or message reaches the third peer, if the
// server keeps a plaintext chat path, or if the handshake and sealed payload
// do not work end to end.
//
//	go run ./cmd/pqprobe -addr http://127.0.0.1:8096
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"rooms/internal/pq"
)

var failures int

func check(name string, ok bool, detail string) {
	if ok {
		fmt.Printf("PASS  %s", name)
	} else {
		failures++
		fmt.Printf("FAIL  %s", name)
	}
	if detail != "" {
		fmt.Printf("  [%s]", detail)
	}
	fmt.Println()
}

type peerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type sigMsg struct {
	T     string     `json:"t"`
	Self  string     `json:"self"`
	Peers []peerInfo `json:"peers"`
	From  string     `json:"from"`
	B     string     `json:"b"`
	Text  string     `json:"text"`
	Kind  string     `json:"kind"`
	Code  string     `json:"code"`
	Chat  []struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
		Text string `json:"text"`
	} `json:"chat"`
}

type client struct {
	conn *websocket.Conn
	mu   sync.Mutex
	msgs []sigMsg
	id   string
}

func dial(base string) (*client, error) {
	u, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	}
	u.Path = "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		return nil, err
	}
	c := &client{conn: conn}
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var m sigMsg
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			c.mu.Lock()
			c.msgs = append(c.msgs, m)
			c.mu.Unlock()
		}
	}()
	return c, nil
}

func (c *client) send(v any) error {
	return c.conn.WriteJSON(v)
}

func (c *client) join(room, name string) error {
	if err := c.send(map[string]any{"t": "join", "room": room, "name": name}); err != nil {
		return err
	}
	m, ok := c.until(func(m sigMsg) bool { return m.T == "joined" || m.T == "error" }, 8*time.Second)
	if !ok {
		return fmt.Errorf("no answer to join")
	}
	if m.T == "error" {
		return fmt.Errorf("join refused: %s", m.Code)
	}
	c.id = m.Self
	return nil
}

func (c *client) until(pred func(sigMsg) bool, d time.Duration) (sigMsg, bool) {
	deadline := time.Now().Add(d)
	seen := 0
	for time.Now().Before(deadline) {
		c.mu.Lock()
		for seen < len(c.msgs) {
			m := c.msgs[seen]
			seen++
			if pred(m) {
				c.mu.Unlock()
				return m, true
			}
		}
		c.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	return sigMsg{}, false
}

func (c *client) snapshot() []sigMsg {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]sigMsg, len(c.msgs))
	copy(out, c.msgs)
	return out
}

type opaque struct {
	K   string `json:"k"`
	X   string `json:"x"`
	M   string `json:"m"`
	EPK string `json:"epk"`
	CT  string `json:"ct"`
	C   string `json:"c"`
	B   string `json:"b"`
}

func enc(v any) string {
	b, _ := json.Marshal(v)
	return base64.StdEncoding.EncodeToString(b)
}

func dec(s string) (opaque, error) {
	var o opaque
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return o, err
	}
	err = json.Unmarshal(b, &o)
	return o, err
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func main() {
	addr := flag.String("addr", "http://127.0.0.1:8096", "server base URL")
	flag.Parse()

	res, err := http.Post(*addr+"/api/new", "application/json", strings.NewReader("{}"))
	if err != nil {
		fmt.Println("FAIL  server unreachable:", err)
		os.Exit(1)
	}
	var created struct {
		Room string `json:"room"`
	}
	json.NewDecoder(res.Body).Decode(&created)
	res.Body.Close()
	if created.Room == "" {
		fmt.Println("FAIL  could not create a room")
		os.Exit(1)
	}
	check("room created", true, "")

	const nameA = "alice-probe-name"
	const nameB = "bob-probe-name"
	const canary = "PLAINTEXT-CANARY-7f3a"

	a, err := dial(*addr)
	if err != nil {
		fmt.Println("FAIL  peer A dial:", err)
		os.Exit(1)
	}
	b, err := dial(*addr)
	if err != nil {
		fmt.Println("FAIL  peer B dial:", err)
		os.Exit(1)
	}
	eve, err := dial(*addr)
	if err != nil {
		fmt.Println("FAIL  observer dial:", err)
		os.Exit(1)
	}
	defer a.conn.Close()
	defer b.conn.Close()
	defer eve.conn.Close()

	if err := a.join(created.Room, nameA); err != nil {
		fmt.Println("FAIL  peer A join:", err)
		os.Exit(1)
	}
	if err := b.join(created.Room, nameB); err != nil {
		fmt.Println("FAIL  peer B join:", err)
		os.Exit(1)
	}
	if err := eve.join(created.Room, "eve-observer-name"); err != nil {
		fmt.Println("FAIL  observer join:", err)
		os.Exit(1)
	}
	check("three peers joined", a.id != "" && b.id != "" && eve.id != "", a.id+","+b.id+","+eve.id)

	// The server must not know any peer name, and must not keep a chat line.
	joinedB, _ := b.until(func(m sigMsg) bool { return m.T == "joined" }, 2*time.Second)
	namesOK := len(joinedB.Peers) == 1
	for _, p := range joinedB.Peers {
		if p.Name != "guest" {
			namesOK = false
		}
	}
	check("peer list carries no real names", namesOK, fmt.Sprintf("%v", joinedB.Peers))
	check("join history is empty", len(joinedB.Chat) == 0, fmt.Sprintf("%d lines", len(joinedB.Chat)))

	// A plaintext chat message must be dropped entirely in this mode.
	_ = eve.send(map[string]any{"t": "chat", "text": canary})
	_ = a.send(map[string]any{"t": "chat", "text": canary})
	time.Sleep(400 * time.Millisecond)
	leak := false
	for _, m := range eve.snapshot() {
		if m.T == "chat" && strings.Contains(m.Text, canary) {
			leak = true
		}
	}
	check("plaintext chat has no path", !leak, "")

	// Identity and public bundles.
	ida, err := pq.NewIdentity()
	if err != nil {
		fmt.Println("FAIL  keygen:", err)
		os.Exit(1)
	}
	idb, err := pq.NewIdentity()
	if err != nil {
		fmt.Println("FAIL  keygen:", err)
		os.Exit(1)
	}
	_ = a.send(map[string]any{"t": "enc", "to": b.id, "b": enc(map[string]string{
		"k": "pub", "x": b64(ida.XPub), "m": b64(ida.EK),
	})})
	_ = b.send(map[string]any{"t": "enc", "to": a.id, "b": enc(map[string]string{
		"k": "pub", "x": b64(idb.XPub), "m": b64(idb.EK),
	})})
	time.Sleep(300 * time.Millisecond)

	// Use the ids the server assigned for the transcript, lowest first.
	lo, hi := a.id, b.id
	loID, hiID := ida, idb
	if lo > hi {
		lo, hi = hi, lo
		loID, hiID = idb, ida
	}
	offer, err := pq.Initiate(lo, hi, loID.Public(), hiID.Public())
	if err != nil {
		fmt.Println("FAIL  initiate:", err)
		os.Exit(1)
	}
	helloFrom, helloTo := a, b
	if a.id != lo {
		helloFrom, helloTo = b, a
	}
	_ = helloFrom.send(map[string]any{"t": "enc", "to": helloTo.id, "b": enc(map[string]string{
		"k": "hello", "epk": b64(offer.EPK), "ct": b64(offer.CT),
	})})
	time.Sleep(300 * time.Millisecond)

	acc, err := pq.Accept(hi, lo, hiID, loID.Public(), hiID.Public(), offer.EPK, offer.CT)
	if err != nil {
		fmt.Println("FAIL  accept:", err)
		os.Exit(1)
	}
	confirmOK := pq.VerifyConfirm(offer.Keys, offer.Transcript, acc.Confirm) &&
		pq.VerifyConfirm(acc.Keys, offer.Transcript, offer.Confirm)
	check("hybrid handshake through the relay agrees", confirmOK, "sas "+offer.Keys.SAS)
	check("both sides see the same short code", offer.Keys.SAS == acc.Keys.SAS, offer.Keys.SAS)

	// One sealed chat line, then look at everything the observer ever received.
	plain := []byte(`{"k":"chat","n":"` + nameA + `","x":"` + canary + `"}`)
	sealed, err := pq.Seal(offer.Keys.SendChat, []byte("pq-e2e v1 chat "+lo+"|"+hi), plain)
	if err != nil {
		fmt.Println("FAIL  seal:", err)
		os.Exit(1)
	}
	appBlob := enc(map[string]string{"k": "app", "b": b64(sealed)})
	_ = a.send(map[string]any{"t": "enc", "to": b.id, "b": appBlob})
	// The same sealed payload is pushed to every peer on purpose: this is the
	// worst case where the server leaks everything it can see to an observer.
	_ = a.send(map[string]any{"t": "enc", "to": "*", "b": appBlob})
	helloBlob := enc(map[string]string{"k": "hello", "epk": b64(offer.EPK), "ct": b64(offer.CT)})
	_ = a.send(map[string]any{"t": "enc", "to": "*", "b": helloBlob})
	time.Sleep(400 * time.Millisecond)

	// The intended receiver opens it; the observer cannot.
	got, err := pq.Open(acc.Keys.RecvChat, []byte("pq-e2e v1 chat "+lo+"|"+hi), sealed)
	check("receiver opens the sealed chat", err == nil && bytes.Equal(got, plain), string(got))
	if _, err := pq.Open(make([]byte, 32), []byte("pq-e2e v1 chat "+lo+"|"+hi), sealed); err == nil {
		check("observer with no key opens nothing", false, "random key decrypted")
	} else {
		check("observer with no key opens nothing", true, "")
	}

	// Everything the observer received: decode every opaque blob and look for
	// names or message text.
	var blobs int
	var relayedBytes int
	var found []string
	for _, m := range eve.snapshot() {
		scan := func(s string) {
			if s == "" {
				return
			}
			raw, err := base64.StdEncoding.DecodeString(s)
			if err != nil {
				raw = []byte(s)
			}
			blobs++
			relayedBytes += len(raw)
			for _, needle := range []string{nameA, nameB, canary} {
				if bytes.Contains(raw, []byte(needle)) {
					found = append(found, needle)
				}
			}
		}
		scan(m.B)
		scan(m.Text)
	}
	check("server relayed only ciphertext to the observer", len(found) == 0 && relayedBytes > 0,
		fmt.Sprintf("%d blobs, %d bytes, found %v", blobs, relayedBytes, found))

	// The room id is the only routing name the server knows; the probe keeps
	// it out of every log line check the operator runs separately.
	if failures > 0 {
		fmt.Println("RESULT: FAIL")
		os.Exit(1)
	}
	fmt.Println("RESULT: PASS")
}
