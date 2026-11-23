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
		// One gate for a pair: the peer's identity signature and its key
		// confirmation tag, both or neither.
		"proved": js.FuncOf(proved),
		"seal":   js.FuncOf(seal),
		"open":   js.FuncOf(open),
		// The long-term identity: generated, signed with and verified here, so
		// the browser needs no second crypto library. A page that can hold a
		// non-extractable WebCrypto key signs there and only verifies here.
		"idgen":    js.FuncOf(idgen),
		"idsign":   js.FuncOf(idsign),
		"idverify": js.FuncOf(idverify),
		"idfp":     js.FuncOf(idfp),
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
	X   string `json:"x"`
	K   string `json:"k"`
	ID  string `json:"id"`
	SID string `json:"sid"`
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
	id, err := b64d(p.ID)
	if err != nil {
		return pq.Public{}, err
	}
	sid, err := b64d(p.SID)
	if err != nil {
		return pq.Public{}, err
	}
	return pq.Public{X: x, KEM: k, ID: id, SID: sid}, nil
}

func initiate(_ js.Value, args []js.Value) any {
	var in struct {
		Self    string `json:"self"`
		Peer    string `json:"peer"`
		SelfX   string `json:"selfX"`
		SelfK   string `json:"selfK"`
		SelfID  string `json:"selfID"`
		SelfSID string `json:"selfSID"`
		PeerX   string `json:"peerX"`
		PeerK   string `json:"peerK"`
		PeerID  string `json:"peerID"`
		PeerSID string `json:"peerSID"`
	}
	if err := json.Unmarshal([]byte(argString(args)), &in); err != nil {
		return fail(err)
	}
	selfPub, err := (pubIn{in.SelfX, in.SelfK, in.SelfID, in.SelfSID}).public()
	if err != nil {
		return fail(err)
	}
	peerPub, err := (pubIn{in.PeerX, in.PeerK, in.PeerID, in.PeerSID}).public()
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
		Self    string `json:"self"`
		Peer    string `json:"peer"`
		SelfX   string `json:"selfX"`
		SelfSK  string `json:"selfSK"`
		SelfK   string `json:"selfK"`
		SelfDK  string `json:"selfDK"`
		SelfID  string `json:"selfID"`
		SelfSID string `json:"selfSID"`
		PeerX   string `json:"peerX"`
		PeerK   string `json:"peerK"`
		PeerID  string `json:"peerID"`
		PeerSID string `json:"peerSID"`
		EPK     string `json:"epk"`
		CT      string `json:"ct"`
		Sig     string `json:"sig"`
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
	sig, err := b64d(in.Sig)
	if err != nil {
		return fail(err)
	}
	peerPub, err := (pubIn{in.PeerX, in.PeerK, in.PeerID, in.PeerSID}).public()
	if err != nil {
		return fail(err)
	}
	selfPub, err := (pubIn{in.SelfX, in.SelfK, in.SelfID, in.SelfSID}).public()
	if err != nil {
		return fail(err)
	}
	self := &pq.Identity{XPub: xpub, XSk: xsk, EK: ek, DK: dk}
	acc, err := pq.Accept(in.Self, in.Peer, self, peerPub, selfPub, epk, ct, sig)
	if err != nil {
		return fail(err)
	}
	return reply(map[string]any{
		"confirm":    b64e(acc.Confirm),
		"transcript": b64e(acc.Transcript),
		"keys":       wrapKeys(acc.Keys),
	})
}

// proved is the mutual gate the client uses: a pair is only usable when the
// peer signed this transcript and its confirmation tag matches.
func proved(_ js.Value, args []js.Value) any {
	var in struct {
		Key        string `json:"key"` // the receive media key of this pair
		Transcript string `json:"transcript"`
		Tag        string `json:"tag"`
		ID         string `json:"id"` // the peer's Ed25519 public key
		Sig        string `json:"sig"`
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
	id, err := b64d(in.ID)
	if err != nil {
		return reply(map[string]any{"ok": false, "error": err.Error()})
	}
	sig, err := b64d(in.Sig)
	if err != nil {
		return reply(map[string]any{"ok": false, "error": err.Error()})
	}
	if len(key) != 32 {
		return reply(map[string]any{"ok": false, "error": "key size"})
	}
	// Only the receive half matters here: the tag is checked against the key
	// this side would decrypt the peer's media with.
	if err := pq.Proved(pq.Keys{RecvMedia: key}, tr, tag, id, sig); err != nil {
		return reply(map[string]any{"ok": false, "error": err.Error()})
	}
	return reply(map[string]any{"ok": true})
}

func idgen(js.Value, []js.Value) any {
	key, err := pq.NewSigningKey()
	if err != nil {
		return fail(err)
	}
	return reply(map[string]string{
		"seed": b64e(key.Seed()),
		"pub":  b64e(key.PublicKey()),
	})
}

// idsign signs one transcript with a seed the caller holds. Only a browser
// without WebCrypto Ed25519 uses it, so the seed exists because the browser
// gave no way to keep the key itself.
func idsign(_ js.Value, args []js.Value) any {
	var in struct {
		Seed string `json:"seed"`
		Msg  string `json:"msg"`
	}
	if err := json.Unmarshal([]byte(argString(args)), &in); err != nil {
		return fail(err)
	}
	seed, err := b64d(in.Seed)
	if err != nil {
		return fail(err)
	}
	msg, err := b64d(in.Msg)
	if err != nil {
		return fail(err)
	}
	key, err := pq.SigningKeyFromSeed(seed)
	if err != nil {
		return fail(err)
	}
	return reply(map[string]string{"sig": b64e(key.Sign(msg))})
}

func idverify(_ js.Value, args []js.Value) any {
	var in struct {
		ID  string `json:"id"`
		Msg string `json:"msg"`
		Sig string `json:"sig"`
	}
	if err := json.Unmarshal([]byte(argString(args)), &in); err != nil {
		return reply(map[string]any{"ok": false, "error": err.Error()})
	}
	id, err := b64d(in.ID)
	if err != nil {
		return reply(map[string]any{"ok": false, "error": err.Error()})
	}
	msg, err := b64d(in.Msg)
	if err != nil {
		return reply(map[string]any{"ok": false, "error": err.Error()})
	}
	sig, err := b64d(in.Sig)
	if err != nil {
		return reply(map[string]any{"ok": false, "error": err.Error()})
	}
	return reply(map[string]any{"ok": pq.VerifySignature(id, msg, sig)})
}

func idfp(_ js.Value, args []js.Value) any {
	var in struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(argString(args)), &in); err != nil {
		return fail(err)
	}
	id, err := b64d(in.ID)
	if err != nil {
		return fail(err)
	}
	if len(id) != pq.IDSize {
		return fail(pq.ErrShape)
	}
	return reply(map[string]string{"fp": pq.Fingerprint(id)})
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
