package pq

import (
	"bytes"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// peer is one browser: the long-term identity it signs with, the per-call
// key material, and the bundle it broadcasts.
type peer struct {
	sign *SigningKey
	self *Identity
	pub  Public
}

func newPeer(t *testing.T) *peer {
	t.Helper()
	sign, err := NewSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	self, err := NewIdentity()
	if err != nil {
		t.Fatal(err)
	}
	sid := make([]byte, SIDSize)
	if _, err := rand.Read(sid); err != nil {
		t.Fatal(err)
	}
	pub := self.Public()
	pub.ID = sign.PublicKey()
	pub.SID = sid
	return &peer{sign: sign, self: self, pub: pub}
}

type handshake struct {
	alice, bob *peer
	offer      *Offer
	acc        *AcceptResult
	helloSig   []byte
}

func shakePeers(t *testing.T, alice, bob *peer) *handshake {
	t.Helper()
	h := &handshake{alice: alice, bob: bob}
	var err error
	// "a1" sorts before "b2", so alice initiates.
	h.offer, err = Initiate("a1", "b2", alice.pub, bob.pub)
	if err != nil {
		t.Fatal(err)
	}
	h.helloSig = alice.sign.Sign(h.offer.Transcript)
	h.acc, err = Accept("b2", "a1", bob.self, alice.pub, bob.pub, h.offer.EPK, h.offer.CT, h.helloSig)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func shake(t *testing.T) *handshake {
	t.Helper()
	return shakePeers(t, newPeer(t), newPeer(t))
}

func TestHandshakeAgrees(t *testing.T) {
	h := shake(t)
	offer, acc := h.offer, h.acc

	if !bytes.Equal(offer.Keys.SendMedia, acc.Keys.RecvMedia) {
		t.Fatal("initiator send key does not match responder receive key")
	}
	if !bytes.Equal(offer.Keys.RecvMedia, acc.Keys.SendMedia) {
		t.Fatal("initiator receive key does not match responder send key")
	}
	if !bytes.Equal(offer.Keys.SendChat, acc.Keys.RecvChat) {
		t.Fatal("chat key mismatch")
	}
	if offer.Keys.SendMedia == nil || len(offer.Keys.SendMedia) != 32 {
		t.Fatalf("media key size %d", len(offer.Keys.SendMedia))
	}
	if offer.Keys.SAS != acc.Keys.SAS {
		t.Fatalf("sas mismatch %q %q", offer.Keys.SAS, acc.Keys.SAS)
	}
	if len(offer.Keys.SAS) != 13 {
		t.Fatalf("sas length %d", len(offer.Keys.SAS))
	}
	// The initiator uses its receive key to verify the responder's tag.
	if !VerifyConfirm(offer.Keys, offer.Transcript, acc.Confirm) {
		t.Fatal("initiator could not verify responder confirmation")
	}
	if !VerifyConfirm(acc.Keys, offer.Transcript, offer.Confirm) {
		t.Fatal("responder could not verify initiator confirmation")
	}
	// The responder signs the same transcript, so the initiator can pin it.
	if !VerifySignature(h.bob.pub.ID, offer.Transcript, h.bob.sign.Sign(offer.Transcript)) {
		t.Fatal("responder signature does not verify")
	}
	// Direction separation: the same key must not authenticate the other way.
	if VerifyConfirm(offer.Keys, offer.Transcript, offer.Confirm) {
		t.Fatal("confirmation verified in the wrong direction")
	}
	if len(offer.EPK) != X25519Size || len(offer.CT) != 1088 {
		t.Fatalf("offer sizes epk=%d ct=%d", len(offer.EPK), len(offer.CT))
	}
}

// TestTranscriptBindsIdentityAndSession covers the two substitutions a relay
// would try: another identity key, and another session id.
func TestTranscriptBindsIdentityAndSession(t *testing.T) {
	h := shake(t)

	mallory := newPeer(t)
	other := h.alice.pub
	other.ID = mallory.pub.ID

	// A signature from alice's key over a transcript that names mallory's key
	// is not mallory's signature, and it is not accepted as alice's either.
	sig := h.alice.sign.Sign(transcript("a1", "b2", other, h.bob.pub, h.offer.EPK, h.offer.CT))
	if VerifySignature(h.alice.pub.ID, h.offer.Transcript, sig) {
		t.Fatal("a transcript with another identity key verified")
	}
	if _, err := Accept("b2", "a1", h.bob.self, other, h.bob.pub, h.offer.EPK, h.offer.CT, sig); err == nil {
		t.Fatal("accept took a hello signed over another identity key")
	}

	// The same hello under a fresh session id belongs to another call.
	fresh := h.bob.pub
	fresh.SID = make([]byte, SIDSize)
	if _, err := rand.Read(fresh.SID); err != nil {
		t.Fatal(err)
	}
	if _, err := Accept("b2", "a1", h.bob.self, h.alice.pub, fresh, h.offer.EPK, h.offer.CT, h.helloSig); err == nil {
		t.Fatal("accept took a hello from another session id")
	}

	// A missing signature is refused, which is the refusal that closes the
	// downgrade path: no identity fields, no handshake.
	if _, err := Accept("b2", "a1", h.bob.self, h.alice.pub, h.bob.pub, h.offer.EPK, h.offer.CT, nil); err == nil {
		t.Fatal("accept took an unsigned hello")
	}
	if _, err := Accept("b2", "a1", h.bob.self, h.alice.pub, h.bob.pub, h.offer.EPK, h.offer.CT, []byte("short")); err == nil {
		t.Fatal("accept took a malformed signature")
	}

	// A bundle without an identity or a session id is not a bundle.
	noID := h.alice.pub
	noID.ID = nil
	if _, err := Initiate("a1", "b2", noID, h.bob.pub); err == nil {
		t.Fatal("initiate took a bundle without an identity")
	}
}

// TestReplayedHelloIsRefused replays a recorded hello into a fresh handshake:
// same signature, same session id, fresh ephemeral material. The signature
// covers the ephemeral keys, so the replay no longer describes this call.
func TestReplayedHelloIsRefused(t *testing.T) {
	h := shake(t)

	replay, err := Initiate("a1", "b2", h.alice.pub, h.bob.pub)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(replay.EPK, h.offer.EPK) {
		t.Fatal("the second handshake reused the ephemeral key")
	}
	if _, err := Accept("b2", "a1", h.bob.self, h.alice.pub, h.bob.pub, replay.EPK, replay.CT, h.helloSig); err == nil {
		t.Fatal("accept took an old hello with fresh ephemeral keys")
	}
}

// TestCompromisedIdentityCannotRecoverSessionKey is the key-compromise case:
// the attacker holds both long-term keys and everything that crossed the wire,
// and still gets no session key.
func TestCompromisedIdentityCannotRecoverSessionKey(t *testing.T) {
	h := shake(t)
	aad := []byte("pq-e2e v2 chat a1|b2")
	plain := []byte(`{"k":"chat","x":"the meeting is at seven"}`)
	blob, err := Seal(h.offer.Keys.SendChat, aad, plain)
	if err != nil {
		t.Fatal(err)
	}

	// The stolen identity still signs, so impersonation is real.
	if !VerifySignature(h.alice.pub.ID, h.offer.Transcript, h.alice.sign.Sign(h.offer.Transcript)) {
		t.Fatal("the stolen identity can no longer sign")
	}

	// The best an identity key can do is feed bytes into the derivation. Every
	// path from a seed and from the public transcript gives another key.
	tr := h.offer.Transcript
	sum := sha256.Sum256(h.alice.sign.Seed())
	guesses := map[string][]byte{
		"alice seed":           h.alice.sign.Seed(),
		"bob seed":             h.bob.sign.Seed(),
		"both seeds":           append(h.alice.sign.Seed(), h.bob.sign.Seed()...),
		"transcript":           tr,
		"identity signature":   h.alice.sign.Sign(tr),
		"identity and sids":    append(h.alice.sign.Seed(), h.alice.pub.SID...),
		"hash of the identity": sum[:],
	}
	for name, guess := range guesses {
		if len(guess) != mediaKeySize {
			guess = hkdfOf(t, guess, tr)
		}
		if bytes.Equal(guess, h.offer.Keys.SendChat) {
			t.Fatalf("%s reproduced the session key", name)
		}
		if _, err := Open(guess, aad, blob); err == nil {
			t.Fatalf("%s opened the recorded chat line", name)
		}
	}

	// The secret the attacker misses is the responder's ephemeral X25519 half;
	// an identity-shaped stand-in produces a different key and a failed tag.
	eph, err := ecdh.X25519().NewPrivateKey(h.bob.sign.Seed())
	if err != nil {
		t.Fatal(err)
	}
	epk, err := ecdh.X25519().NewPublicKey(h.offer.EPK)
	if err != nil {
		t.Fatal(err)
	}
	guessDH, err := eph.ECDH(epk)
	if err != nil {
		t.Fatal(err)
	}
	okm, err := derive(guessDH, h.bob.sign.Seed(), tr)
	if err != nil {
		t.Fatal(err)
	}
	guess := splitKeys(okm, false)
	if bytes.Equal(guess.SendChat, h.acc.Keys.SendChat) {
		t.Fatal("an identity key stood in for the ephemeral secret")
	}
	if VerifyConfirm(guess, tr, h.offer.Confirm) || VerifyConfirm(guess, tr, h.acc.Confirm) {
		t.Fatal("a key built from identity material passed the confirmation")
	}
}

// TestPerfectForwardSecrecy states the property plainly: every call draws new
// ephemeral secrets, the session key needs them, and nothing a stored identity
// can produce opens a recorded call.
func TestPerfectForwardSecrecy(t *testing.T) {
	alice, bob := newPeer(t), newPeer(t)
	// Two calls with the same devices, identities and session ids share no key,
	// because the ephemeral halves are new.
	first := shakePeers(t, alice, bob)
	second := shakePeers(t, alice, bob)
	if bytes.Equal(first.offer.Keys.SendMedia, second.offer.Keys.SendMedia) ||
		first.offer.Keys.SAS == second.offer.Keys.SAS {
		t.Fatal("two calls with the same identities shared a key")
	}
	if bytes.Equal(first.offer.Transcript, second.offer.Transcript) {
		t.Fatal("two calls produced the same transcript")
	}
	// A recorded call stays closed to both long-term keys.
	aad := []byte("pq-e2e v2 chat a1|b2")
	blob, err := Seal(first.offer.Keys.RecvChat, aad, []byte("recorded"))
	if err != nil {
		t.Fatal(err)
	}
	for _, seed := range [][]byte{alice.sign.Seed(), bob.sign.Seed()} {
		if _, err := Open(hkdfOf(t, seed, first.offer.Transcript), aad, blob); err == nil {
			t.Fatal("a long-term identity opened a recorded call")
		}
	}
}

// TestBothSidesProve is the F2 regression: a pair is only usable when the
// peer that answered signed the same transcript. The relay can always answer
// as itself, so the signature is not enough on its own; what it removes is the
// silent case where the answering side proves nothing at all.
func TestBothSidesProve(t *testing.T) {
	h := shake(t)
	bobSig := h.bob.sign.Sign(h.offer.Transcript)

	// The initiator checks the responder: tag and signature, both or neither.
	if err := Proved(h.offer.Keys, h.offer.Transcript, h.acc.Confirm, h.bob.pub.ID, bobSig); err != nil {
		t.Fatalf("the initiator refused a properly signed responder: %v", err)
	}
	if err := Proved(h.offer.Keys, h.offer.Transcript, h.acc.Confirm, h.bob.pub.ID, nil); err == nil {
		t.Fatal("the initiator took an ok with no signature")
	}
	if err := Proved(h.offer.Keys, h.offer.Transcript, h.acc.Confirm, h.bob.pub.ID, []byte("short")); err == nil {
		t.Fatal("the initiator took a malformed ok signature")
	}
	// The initiator's own signature must not pass as the responder's.
	if err := Proved(h.offer.Keys, h.offer.Transcript, h.acc.Confirm, h.bob.pub.ID, h.helloSig); err == nil {
		t.Fatal("the initiator took its own signature as the responder's")
	}
	// A right signature with a wrong tag is still refused.
	if err := Proved(h.offer.Keys, h.offer.Transcript, h.offer.Confirm, h.bob.pub.ID, bobSig); err == nil {
		t.Fatal("a mismatched confirmation tag was accepted")
	}

	// The responder checks the initiator the same way, with its own keys.
	if err := Proved(h.acc.Keys, h.offer.Transcript, h.offer.Confirm, h.alice.pub.ID, h.helloSig); err != nil {
		t.Fatalf("the responder refused a properly signed initiator: %v", err)
	}
	if err := Proved(h.acc.Keys, h.offer.Transcript, h.offer.Confirm, h.alice.pub.ID, nil); err == nil {
		t.Fatal("the responder took an unsigned hello")
	}
}

// TestRelayAsResponderNeedsThePin states what a signature can and cannot do. A
// relay that answers with its own identity produces a transcript that verifies
// and a tag that matches, so the crypto gate passes; only the fingerprint the
// initiator pinned tells Alice that she is talking to the relay, which is why
// the client refuses a changed pin and shows every new one as unverified.
func TestRelayAsResponderNeedsThePin(t *testing.T) {
	alice, bob := newPeer(t), newPeer(t)
	relay := newPeer(t)

	// What the relay sends Alice instead of Bob's bundle.
	fake := relay.pub
	offer, err := Initiate("a1", "b2", alice.pub, fake)
	if err != nil {
		t.Fatal(err)
	}
	hello := alice.sign.Sign(offer.Transcript)
	acc, err := Accept("b2", "a1", relay.self, alice.pub, fake, offer.EPK, offer.CT, hello)
	if err != nil {
		t.Fatalf("the relay could not answer as itself: %v", err)
	}
	relaySig := relay.sign.Sign(offer.Transcript)
	if err := Proved(offer.Keys, offer.Transcript, acc.Confirm, fake.ID, relaySig); err != nil {
		t.Fatalf("the relay's own identity did not pass the crypto gate: %v", err)
	}
	// The crypto gate cannot tell Bob from the relay; the pin can.
	if Fingerprint(fake.ID) == Fingerprint(bob.pub.ID) {
		t.Fatal("two identities share a fingerprint")
	}
	// And the relay cannot answer as Bob, because it has no key to sign with.
	if VerifySignature(bob.pub.ID, offer.Transcript, relaySig) {
		t.Fatal("a relay signature verified under the peer's identity")
	}
}

func hkdfOf(t *testing.T, ikm, salt []byte) []byte {
	t.Helper()
	out, err := hkdf.Key(sha256.New, ikm, salt, Protocol+" keys", mediaKeySize)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestTamperedCiphertextChangesKeys(t *testing.T) {
	h := shake(t)
	bad := append([]byte(nil), h.offer.CT...)
	bad[100] ^= 0x80
	// A relay that flips one byte of the ciphertext also breaks the signature
	// over the transcript, so the hello is refused before any key is derived.
	if _, err := Accept("b2", "a1", h.bob.self, h.alice.pub, h.bob.pub, h.offer.EPK, bad, h.helloSig); err == nil {
		t.Fatal("accept took a hello whose ciphertext no longer matches its signature")
	}
	// Even a sender-signed corrupted ciphertext yields another key: FIPS 203
	// implicit rejection returns a secret, and the confirmation catches it.
	tr := transcript("a1", "b2", h.alice.pub, h.bob.pub, h.offer.EPK, bad)
	acc, err := Accept("b2", "a1", h.bob.self, h.alice.pub, h.bob.pub, h.offer.EPK, bad, h.alice.sign.Sign(tr))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(acc.Keys.SendMedia, h.offer.Keys.RecvMedia) {
		t.Fatal("tampered ML-KEM ciphertext still produced the same key")
	}
	if VerifyConfirm(h.offer.Keys, acc.Transcript, acc.Confirm) {
		t.Fatal("tampered handshake passed key confirmation")
	}
}

func TestTamperedEphemeralChangesKeys(t *testing.T) {
	h := shake(t)
	epk := append([]byte(nil), h.offer.EPK...)
	epk[0] ^= 1
	// A changed ephemeral key changes the transcript, so the signature over
	// the old one no longer applies; signing the new one shows the keys differ.
	tr := transcript("a1", "b2", h.alice.pub, h.bob.pub, epk, h.offer.CT)
	acc, err := Accept("b2", "a1", h.bob.self, h.alice.pub, h.bob.pub, epk, h.offer.CT, h.alice.sign.Sign(tr))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(acc.Keys.SendMedia, h.offer.Keys.RecvMedia) {
		t.Fatal("tampered X25519 key still produced the same key")
	}
}

func TestNoKeyCannotOpenChat(t *testing.T) {
	h := shake(t)

	// What a peer sends as one chat line.
	plain := []byte(`{"n":"alice","x":"the meeting is at seven"}`)
	aad := []byte("pq-e2e v2 chat a1|b2")
	blob, err := Seal(h.offer.Keys.SendChat, aad, plain)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(blob, []byte("alice")) || bytes.Contains(blob, []byte("seven")) {
		t.Fatal("ciphertext contains plaintext")
	}
	if bytes.Contains(blob, plain) {
		t.Fatal("ciphertext contains the whole plaintext")
	}

	// A relay (the server) sees only the framed blob. It has no key.
	if _, err := Open(bytes.Repeat([]byte{7}, 32), aad, blob); err == nil {
		t.Fatal("random key opened the payload")
	}
	// Nor does the media key, so media and chat domains are separated.
	if _, err := Open(h.offer.Keys.SendMedia, aad, blob); err == nil {
		t.Fatal("media key opened a chat payload")
	}
	// Wrong AAD fails too.
	if _, err := Open(h.offer.Keys.SendChat, []byte("other"), blob); err == nil {
		t.Fatal("payload opened with the wrong associated data")
	}

	got, err := Open(h.offer.Keys.SendChat, aad, blob)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("owner could not open its own payload: %v", err)
	}
}

func TestSealIsFresh(t *testing.T) {
	h := shake(t)
	aad := []byte("aad")
	one, _ := Seal(h.offer.Keys.SendChat, aad, []byte("same"))
	two, _ := Seal(h.offer.Keys.SendChat, aad, []byte("same"))
	if bytes.Equal(one, two) {
		t.Fatal("two seals of the same plaintext are identical")
	}
}

// TestRelaySeesOnlyCiphertext models the signaling server: it receives the
// handshake blobs and the chat blob and tries to learn anything.
func TestRelaySeesOnlyCiphertext(t *testing.T) {
	h := shake(t)

	// What the relay forwards as JSON, exactly as the client encodes it.
	wire := map[string]string{
		"epk": b64(h.offer.EPK),
		"ct":  b64(h.offer.CT),
		"sig": b64(h.helloSig),
		"ok":  b64(h.acc.Confirm),
	}
	chat, _ := Seal(h.offer.Keys.SendChat, []byte("chat"), []byte(`{"n":"alice","x":"secret words"}`))
	wire["b"] = b64(chat)
	body, _ := json.Marshal(wire)
	for _, needle := range []string{"alice", "secret words", "bob"} {
		if strings.Contains(string(body), needle) {
			t.Fatalf("relayed JSON contains %q", needle)
		}
	}
	if strings.Contains(string(chat), "alice") {
		t.Fatal("raw chat blob contains a name")
	}
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func TestIdentityRoundTrip(t *testing.T) {
	id, err := NewIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if len(id.XSk) != 32 || len(id.XPub) != 32 || len(id.EK) != 1184 || len(id.DK) != 64 {
		t.Fatalf("identity sizes %d %d %d %d", len(id.XSk), len(id.XPub), len(id.EK), len(id.DK))
	}
	sign, err := NewSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	back, err := SigningKeyFromSeed(sign.Seed())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(back.PublicKey(), sign.PublicKey()) {
		t.Fatal("the seed rebuilt another identity")
	}
	if Fingerprint(sign.PublicKey()) != Fingerprint(back.PublicKey()) {
		t.Fatal("the fingerprint is not stable")
	}
	if _, err := rand.Read(make([]byte, 1)); err != nil {
		t.Fatal(err)
	}
}
