//go:build js && wasm

// Command pqwasm exposes the hybrid key agreement to the browser as a small
// JSON API on globalThis. It is built for GOOS=js GOARCH=wasm and carries no
// UI of its own.
package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"sync"
	"syscall/js"

	"stanze/internal/pq"
	"stanze/internal/spake2"
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
		// The room passphrase never leaves the page. It becomes a scalar here,
		// and the exchange that proves it runs here too.
		"spakew":      js.FuncOf(spakew),
		"spakestart":  js.FuncOf(spakeStart),
		"spakefinish": js.FuncOf(spakeFinish),
		"spakeverify": js.FuncOf(spakeverify),
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

// signingBytes is the one encoding rule of a signed message: what a caller
// hands over is base64 of the exact bytes that were signed, and the signature
// is checked over those bytes. It is the only way idsign and idverify read a
// message, so the two can never disagree, and a signer outside this module
// (WebCrypto Ed25519 in the page) signs the same bytes.
func signingBytes(msg string) ([]byte, error) { return b64d(msg) }

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
	msg, err := signingBytes(in.Msg)
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
	msg, err := signingBytes(in.Msg)
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

// ---------------------------------------------------------------- spake2

// spakeRuns holds the exchanges in flight, so the scalar of a run stays in this
// module and never reaches the page. The page only sees an id. The map is a
// local resource, but a page that starts an exchange and never finishes it
// would still grow it for as long as the tab lives, so it is capped and the
// oldest run is evicted first. A run that is evicted fails its finish with
// "no such exchange" instead of being kept forever.
const spakeRunsMax = 256

var (
	spakeMu   sync.Mutex
	spakeSeq  int
	spakeRuns = map[int]*spake2.Side{}
	spakeFifo []int
)

// spakeKeep adds one run and evicts the oldest while the map is over the cap.
// Entries whose run is gone are dropped from the front on the way.
func spakeKeep(id int, side *spake2.Side) {
	spakeMu.Lock()
	defer spakeMu.Unlock()
	spakeRuns[id] = side
	spakeFifo = append(spakeFifo, id)
	for len(spakeFifo) > 0 {
		if _, live := spakeRuns[spakeFifo[0]]; live {
			if len(spakeRuns) <= spakeRunsMax {
				break
			}
			delete(spakeRuns, spakeFifo[0])
		}
		spakeFifo = spakeFifo[1:]
	}
}

// spakew derives w from the room passphrase. The salt is the room id, so the
// same passphrase in another room gives another scalar.
func spakew(_ js.Value, args []js.Value) any {
	var in struct {
		Pass string `json:"pass"`
		Salt string `json:"salt"`
	}
	if err := json.Unmarshal([]byte(argString(args)), &in); err != nil {
		return fail(err)
	}
	w, err := spake2.Passphrase([]byte(in.Pass), []byte(in.Salt))
	if err != nil {
		return fail(err)
	}
	out := make([]byte, 32)
	w.FillBytes(out)
	return reply(map[string]string{"w": b64e(out)})
}

func spakeScalar(s string) (*big.Int, error) {
	raw, err := b64d(s)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 || len(raw) > 32 {
		return nil, errors.New("spake2: bad scalar")
	}
	return new(big.Int).SetBytes(raw), nil
}

func spakeStart(_ js.Value, args []js.Value) any {
	var in struct {
		W    string `json:"w"`
		Role string `json:"role"`
		A    string `json:"a"`
		B    string `json:"b"`
	}
	if err := json.Unmarshal([]byte(argString(args)), &in); err != nil {
		return fail(err)
	}
	w, err := spakeScalar(in.W)
	if err != nil {
		return fail(err)
	}
	a, err := b64d(in.A)
	if err != nil {
		return fail(err)
	}
	b, err := b64d(in.B)
	if err != nil {
		return fail(err)
	}
	role := spake2.A
	if in.Role == "B" {
		role = spake2.B
	}
	side, err := spake2.Start(role, w, a, b)
	if err != nil {
		return fail(err)
	}
	spakeMu.Lock()
	spakeSeq++
	id := spakeSeq
	spakeMu.Unlock()
	spakeKeep(id, side)
	return reply(map[string]any{"id": id, "msg": b64e(side.Message())})
}

// spakeLookup returns one run by id. The caller uses it outside the lock; the
// side refuses a second Finish or Verify on its own.
func spakeLookup(id int) (*spake2.Side, error) {
	spakeMu.Lock()
	defer spakeMu.Unlock()
	side, ok := spakeRuns[id]
	if !ok {
		return nil, errors.New("spake2: no such exchange")
	}
	return side, nil
}

func spakeDrop(id int) {
	spakeMu.Lock()
	delete(spakeRuns, id)
	// The fifo entry stays: it names a run that is gone, and the next eviction
	// skips it, so the queue is trimmed from the front only.
	spakeMu.Unlock()
}

func spakeFinish(_ js.Value, args []js.Value) any {
	var in struct {
		ID  int    `json:"id"`
		Msg string `json:"msg"`
	}
	if err := json.Unmarshal([]byte(argString(args)), &in); err != nil {
		return fail(err)
	}
	side, err := spakeLookup(in.ID)
	if err != nil {
		return fail(err)
	}
	msg, err := b64d(in.Msg)
	if err != nil {
		// A run whose peer message does not decode is dropped too: it can
		// never finish, and keeping it would only hold its slot.
		spakeDrop(in.ID)
		return fail(err)
	}
	ke, conf, err := side.Finish(msg)
	if err != nil {
		spakeDrop(in.ID)
		return reply(map[string]any{"error": "not a point"})
	}
	return reply(map[string]string{"ke": b64e(ke), "conf": b64e(conf)})
}

// spakeverify checks the peer's confirmation and drops the run, so one exchange
// can not be replayed against the module.
func spakeverify(_ js.Value, args []js.Value) any {
	var in struct {
		ID  int    `json:"id"`
		Tag string `json:"tag"`
	}
	if err := json.Unmarshal([]byte(argString(args)), &in); err != nil {
		return fail(err)
	}
	side, err := spakeLookup(in.ID)
	if err != nil {
		return fail(err)
	}
	tag, err := b64d(in.Tag)
	if err != nil {
		return fail(err)
	}
	ok := side.Verify(tag)
	spakeDrop(in.ID)
	return reply(map[string]any{"ok": ok})
}
