//go:build js && wasm

// Command pqwasm exposes the hybrid key agreement to the browser as a small
// JSON API on globalThis. It is built for GOOS=js GOARCH=wasm and carries no
// UI of its own.
package main

import (
	"encoding/base64"
	"encoding/json"
	"syscall/js"

	"rooms/internal/pq"
)

func main() {
	js.Global().Set("stanzePQ", js.ValueOf(map[string]any{
		"gen":      js.FuncOf(gen),
		"initiate": js.FuncOf(initiate),
		"respond":  js.FuncOf(respond),
		"verify":   js.FuncOf(verify),
		"seal":     js.FuncOf(seal),
		"open":     js.FuncOf(open),
	}))
	select {}
}

func b64e(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func b64d(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }

func reply(v any) js.Value {
	b, err := json.Marshal(v)
	if err != nil {
		b = []byte(`{"error":"encode"}`)
	}
	return js.ValueOf(string(b))
}

func fail(err error) js.Value { return reply(map[string]string{"error": err.Error()}) }

func argString(args []js.Value) string {
	if len(args) == 0 {
		return "{}"
	}
	return args[0].String()
}

func gen(js.Value, []js.Value) any {
	id, err := pq.NewIdentity()
	if err != nil {
		return fail(err)
	}
	return reply(map[string]string{
		"xpub": b64e(id.XPub),
		"xsk":  b64e(id.XSk),
		"ek":   b64e(id.EK),
		"dk":   b64e(id.DK),
	})
}

type keysOut struct {
	SendMedia string `json:"sendMedia"`
	RecvMedia string `json:"recvMedia"`
	SendChat  string `json:"sendChat"`
	RecvChat  string `json:"recvChat"`
	SAS       string `json:"sas"`
}

func wrapKeys(k pq.Keys) keysOut {
	return keysOut{
		SendMedia: b64e(k.SendMedia),
		RecvMedia: b64e(k.RecvMedia),
		SendChat:  b64e(k.SendChat),
		RecvChat:  b64e(k.RecvChat),
		SAS:       k.SAS,
	}
}

type pubIn struct {
	X string `json:"x"`
	K string `json:"k"`
}

func (p pubIn) public() (pq.Public, error) {
	x, err := b64d(p.X)
	if err != nil {
		return pq.Public{}, err
	}
	k, err := b64d(p.K)
	if err != nil {
		return pq.Public{}, err
	}
	return pq.Public{X: x, KEM: k}, nil
}

func initiate(_ js.Value, args []js.Value) any {
	var in struct {
		Self  string `json:"self"`
		Peer  string `json:"peer"`
		SelfX string `json:"selfX"`
		SelfK string `json:"selfK"`
		PeerX string `json:"peerX"`
		PeerK string `json:"peerK"`
	}
	if err := json.Unmarshal([]byte(argString(args)), &in); err != nil {
		return fail(err)
	}
	selfPub, err := (pubIn{in.SelfX, in.SelfK}).public()
	if err != nil {
		return fail(err)
	}
	peerPub, err := (pubIn{in.PeerX, in.PeerK}).public()
	if err != nil {
		return fail(err)
	}
	offer, err := pq.Initiate(in.Self, in.Peer, selfPub, peerPub)
	if err != nil {
		return fail(err)
	}
	return reply(map[string]any{
		"epk":        b64e(offer.EPK),
		"ct":         b64e(offer.CT),
		"confirm":    b64e(offer.Confirm),
		"transcript": b64e(offer.Transcript),
		"keys":       wrapKeys(offer.Keys),
	})
}

func respond(_ js.Value, args []js.Value) any {
	var in struct {
		Self   string `json:"self"`
		Peer   string `json:"peer"`
		SelfX  string `json:"selfX"`
		SelfSK string `json:"selfSK"`
		SelfK  string `json:"selfK"`
		SelfDK string `json:"selfDK"`
		PeerX  string `json:"peerX"`
		PeerK  string `json:"peerK"`
		EPK    string `json:"epk"`
		CT     string `json:"ct"`
	}
	if err := json.Unmarshal([]byte(argString(args)), &in); err != nil {
		return fail(err)
	}
	xsk, err := b64d(in.SelfSK)
	if err != nil {
		return fail(err)
	}
	dk, err := b64d(in.SelfDK)
	if err != nil {
		return fail(err)
	}
	ek, err := b64d(in.SelfK)
	if err != nil {
		return fail(err)
	}
	xpub, err := b64d(in.SelfX)
	if err != nil {
		return fail(err)
	}
	epk, err := b64d(in.EPK)
	if err != nil {
		return fail(err)
	}
	ct, err := b64d(in.CT)
	if err != nil {
		return fail(err)
	}
	peerPub, err := (pubIn{in.PeerX, in.PeerK}).public()
	if err != nil {
		return fail(err)
	}
	self := &pq.Identity{XPub: xpub, XSk: xsk, EK: ek, DK: dk}
	acc, err := pq.Accept(in.Self, in.Peer, self, peerPub, self.Public(), epk, ct)
	if err != nil {
		return fail(err)
	}
	return reply(map[string]any{
		"confirm":    b64e(acc.Confirm),
		"transcript": b64e(acc.Transcript),
		"keys":       wrapKeys(acc.Keys),
	})
}

func verify(_ js.Value, args []js.Value) any {
	var in struct {
		Key        string `json:"key"`
		Transcript string `json:"transcript"`
		Tag        string `json:"tag"`
	}
	if err := json.Unmarshal([]byte(argString(args)), &in); err != nil {
		return reply(map[string]any{"ok": false, "error": err.Error()})
	}
	key, err := b64d(in.Key)
	if err != nil {
		return reply(map[string]any{"ok": false, "error": err.Error()})
	}
	tr, err := b64d(in.Transcript)
	if err != nil {
		return reply(map[string]any{"ok": false, "error": err.Error()})
	}
	tag, err := b64d(in.Tag)
	if err != nil {
		return reply(map[string]any{"ok": false, "error": err.Error()})
	}
	ok := pq.VerifyConfirm(pq.Keys{RecvMedia: key}, tr, tag)
	return reply(map[string]any{"ok": ok})
}

func seal(_ js.Value, args []js.Value) any {
	var in struct {
		Key string `json:"key"`
		AAD string `json:"aad"`
		PT  string `json:"pt"`
	}
	if err := json.Unmarshal([]byte(argString(args)), &in); err != nil {
		return fail(err)
	}
	key, err := b64d(in.Key)
	if err != nil {
		return fail(err)
	}
	aad, err := b64d(in.AAD)
	if err != nil {
		return fail(err)
	}
	pt, err := b64d(in.PT)
	if err != nil {
		return fail(err)
	}
	blob, err := pq.Seal(key, aad, pt)
	if err != nil {
		return fail(err)
	}
	return reply(map[string]string{"b": b64e(blob)})
}

func open(_ js.Value, args []js.Value) any {
	var in struct {
		Key string `json:"key"`
		AAD string `json:"aad"`
		B   string `json:"b"`
	}
	if err := json.Unmarshal([]byte(argString(args)), &in); err != nil {
		return fail(err)
	}
	key, err := b64d(in.Key)
	if err != nil {
		return fail(err)
	}
	aad, err := b64d(in.AAD)
	if err != nil {
		return fail(err)
	}
	blob, err := b64d(in.B)
	if err != nil {
		return fail(err)
	}
	pt, err := pq.Open(key, aad, blob)
	if err != nil {
		return reply(map[string]any{"error": "authentication failed"})
	}
	return reply(map[string]string{"pt": b64e(pt)})
}
