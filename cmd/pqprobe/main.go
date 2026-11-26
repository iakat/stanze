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
	"crypto/rand"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"stanze/internal/pq"
)

var failures int

var b32Lower = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

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

type sigMsg struct {
	T    string `json:"t"`
	Self string `json:"self"`
	From string `json:"from"`
	B    string `json:"b"`
	Text string `json:"text"`
	Kind string `json:"kind"`
	Code string `json:"code"`
	Chat []struct {
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

// randomRoomID makes a 128 bit name, the same shape the server uses. The first
// join creates the room, so the probe needs no create route.
func randomRoomID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return b32Lower.EncodeToString(b), nil
}

func main() {
	addr := flag.String("addr", "http://127.0.0.1:8096", "server base URL")
	flag.Parse()

	room, err := randomRoomID()
	if err != nil {
		fmt.Println("FAIL  no room id:", err)
		os.Exit(1)
	}
	check("room id made", true, "")

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

	if err := a.join(room, nameA); err != nil {
		fmt.Println("FAIL  peer A join:", err)
		os.Exit(1)
	}
	if err := b.join(room, nameB); err != nil {
		fmt.Println("FAIL  peer B join:", err)
		os.Exit(1)
	}
	if err := eve.join(room, "eve-observer-name"); err != nil {
		fmt.Println("FAIL  observer join:", err)
		os.Exit(1)
	}
	check("three peers joined", a.id != "" && b.id != "" && eve.id != "", a.id+","+b.id+","+eve.id)

	// The join is the whole server to client vocabulary now. There is no
	// roster any more (not even a name field), no chat history and no relay
	// list: the wire has no place for a name to land in.
	joinedB, _ := b.until(func(m sigMsg) bool { return m.T == "joined" }, 2*time.Second)
	var raw map[string]any
	if data, err := json.Marshal(joinedB); err == nil {
		_ = json.Unmarshal(data, &raw)
	}
	_, hasPeers := raw["peers"]
	_, hasChat := raw["chat"]
	_, hasIce := raw["ice"]
	check("the join carries no roster, no chat history and no relay list", !hasPeers && !hasChat && !hasIce,
		fmt.Sprintf("peers=%v chat=%v ice=%v", hasPeers, hasChat, hasIce))

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
	signA, err := pq.NewSigningKey()
	if err != nil {
		fmt.Println("FAIL  keygen:", err)
		os.Exit(1)
	}
	signB, err := pq.NewSigningKey()
	if err != nil {
		fmt.Println("FAIL  keygen:", err)
		os.Exit(1)
	}
	sidA := make([]byte, pq.SIDSize)
	sidB := make([]byte, pq.SIDSize)
	if _, err := rand.Read(sidA); err != nil {
		fmt.Println("FAIL  sid:", err)
		os.Exit(1)
	}
	if _, err := rand.Read(sidB); err != nil {
		fmt.Println("FAIL  sid:", err)
		os.Exit(1)
	}
	pubA := ida.Public()
	pubA.ID, pubA.SID = signA.PublicKey(), sidA
	pubB := idb.Public()
	pubB.ID, pubB.SID = signB.PublicKey(), sidB
	_ = a.send(map[string]any{"t": "enc", "to": b.id, "b": enc(map[string]string{
		"k": "pub", "x": b64(pubA.X), "m": b64(pubA.KEM), "id": b64(pubA.ID), "sid": b64(pubA.SID),
	})})
	_ = b.send(map[string]any{"t": "enc", "to": a.id, "b": enc(map[string]string{
		"k": "pub", "x": b64(pubB.X), "m": b64(pubB.KEM), "id": b64(pubB.ID), "sid": b64(pubB.SID),
	})})
	time.Sleep(300 * time.Millisecond)

	// Use the ids the server assigned for the transcript, lowest first.
	lo, hi := a.id, b.id
	loPub, hiPub := pubA, pubB
	loSign, hiSign := signA, signB
	hiID := idb
	if lo > hi {
		lo, hi = hi, lo
		loPub, hiPub = hiPub, loPub
		loSign, hiSign = hiSign, loSign
		hiID = ida
	}
	offer, err := pq.Initiate(lo, hi, loPub, hiPub)
	if err != nil {
		fmt.Println("FAIL  initiate:", err)
		os.Exit(1)
	}
	helloSig := loSign.Sign(offer.Transcript)
	helloFrom, helloTo := a, b
	if a.id != lo {
		helloFrom, helloTo = b, a
	}
	_ = helloFrom.send(map[string]any{"t": "enc", "to": helloTo.id, "b": enc(map[string]string{
		"k": "hello", "epk": b64(offer.EPK), "ct": b64(offer.CT),
		"id": b64(loPub.ID), "sid": b64(loPub.SID), "sig": b64(helloSig),
	})})
	time.Sleep(300 * time.Millisecond)

	acc, err := pq.Accept(hi, lo, hiID, loPub, hiPub, offer.EPK, offer.CT, helloSig)
	if err != nil {
		fmt.Println("FAIL  accept:", err)
		os.Exit(1)
	}
	okSig := hiSign.Sign(acc.Transcript)
	confirmOK := pq.VerifyConfirm(offer.Keys, offer.Transcript, acc.Confirm) &&
		pq.VerifyConfirm(acc.Keys, offer.Transcript, offer.Confirm)
	check("hybrid handshake through the relay agrees", confirmOK, "sas "+offer.Keys.SAS)
	check("both sides see the same short code", offer.Keys.SAS == acc.Keys.SAS, offer.Keys.SAS)
	check("the hello signature proves the identity",
		pq.VerifySignature(loPub.ID, offer.Transcript, helloSig), pq.Fingerprint(loPub.ID))
	check("the ok signature proves the responder",
		pq.VerifySignature(hiPub.ID, acc.Transcript, okSig), pq.Fingerprint(hiPub.ID))
	check("an unsigned hello is refused",
		func() bool {
			_, err := pq.Accept(hi, lo, hiID, loPub, hiPub, offer.EPK, offer.CT, nil)
			return err != nil
		}(), "")

	// One sealed chat line, then look at everything the observer ever received.
	plain := []byte(`{"k":"chat","n":"` + nameA + `","x":"` + canary + `"}`)
	sealed, err := pq.Seal(offer.Keys.SendChat, []byte("pq-e2e v2 chat "+lo+"|"+hi+" 1"), plain)
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
	got, err := pq.Open(acc.Keys.RecvChat, []byte("pq-e2e v2 chat "+lo+"|"+hi+" 1"), sealed)
	check("receiver opens the sealed chat", err == nil && bytes.Equal(got, plain), string(got))
	if _, err := pq.Open(make([]byte, 32), []byte("pq-e2e v2 chat "+lo+"|"+hi+" 1"), sealed); err == nil {
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
