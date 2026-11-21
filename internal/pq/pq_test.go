package pq

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func pair(t *testing.T) (*Identity, *Identity, *Offer, *AcceptResult) {
	t.Helper()
	alice, err := NewIdentity()
	if err != nil {
		t.Fatal(err)
	}
	bob, err := NewIdentity()
	if err != nil {
		t.Fatal(err)
	}
	// "a1" sorts before "b2", so alice initiates.
	offer, err := Initiate("a1", "b2", alice.Public(), bob.Public())
	if err != nil {
		t.Fatal(err)
	}
	acc, err := Accept("b2", "a1", bob, alice.Public(), bob.Public(), offer.EPK, offer.CT)
	if err != nil {
		t.Fatal(err)
	}
	return alice, bob, offer, acc
}

func TestHandshakeAgrees(t *testing.T) {
	_, _, offer, acc := pair(t)

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
	// Direction separation: the same key must not authenticate the other way.
	if VerifyConfirm(offer.Keys, offer.Transcript, offer.Confirm) {
		t.Fatal("confirmation verified in the wrong direction")
	}
	if len(offer.EPK) != X25519Size || len(offer.CT) != 1088 {
		t.Fatalf("offer sizes epk=%d ct=%d", len(offer.EPK), len(offer.CT))
	}
}

func TestTamperedCiphertextChangesKeys(t *testing.T) {
	alice, bob, offer, _ := pair(t)
	bad := append([]byte(nil), offer.CT...)
	bad[100] ^= 0x80
	acc, err := Accept("b2", "a1", bob, alice.Public(), bob.Public(), offer.EPK, bad)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(acc.Keys.SendMedia, offer.Keys.RecvMedia) {
		t.Fatal("tampered ML-KEM ciphertext still produced the same key")
	}
	if VerifyConfirm(offer.Keys, acc.Transcript, acc.Confirm) {
		t.Fatal("tampered handshake passed key confirmation")
	}
}

func TestTamperedEphemeralChangesKeys(t *testing.T) {
	alice, bob, offer, _ := pair(t)
	epk := append([]byte(nil), offer.EPK...)
	epk[0] ^= 1
	acc, err := Accept("b2", "a1", bob, alice.Public(), bob.Public(), epk, offer.CT)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(acc.Keys.SendMedia, offer.Keys.RecvMedia) {
		t.Fatal("tampered X25519 key still produced the same key")
	}
}

func TestNoKeyCannotOpenChat(t *testing.T) {
	_, _, offer, _ := pair(t)

	// What a peer sends as one chat line.
	plain := []byte(`{"n":"alice","x":"the meeting is at seven"}`)
	aad := []byte("pq-e2e v1 chat a1|b2")
	blob, err := Seal(offer.Keys.SendChat, aad, plain)
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
	if _, err := Open(offer.Keys.SendMedia, aad, blob); err == nil {
		t.Fatal("media key opened a chat payload")
	}
	// Wrong AAD fails too.
	if _, err := Open(offer.Keys.SendChat, []byte("other"), blob); err == nil {
		t.Fatal("payload opened with the wrong associated data")
	}

	got, err := Open(offer.Keys.SendChat, aad, blob)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("owner could not open its own payload: %v", err)
	}
}

func TestSealIsFresh(t *testing.T) {
	_, _, offer, _ := pair(t)
	aad := []byte("aad")
	one, _ := Seal(offer.Keys.SendChat, aad, []byte("same"))
	two, _ := Seal(offer.Keys.SendChat, aad, []byte("same"))
	if bytes.Equal(one, two) {
		t.Fatal("two seals of the same plaintext are identical")
	}
}

// TestRelaySeesOnlyCiphertext models the signaling server: it receives the
// handshake blobs and the chat blob and tries to learn anything.
func TestRelaySeesOnlyCiphertext(t *testing.T) {
	_, _, offer, acc := pair(t)

	// What the relay forwards as JSON, exactly as the client encodes it.
	wire := map[string]string{
		"epk": b64(offer.EPK),
		"ct":  b64(offer.CT),
		"ok":  b64(acc.Confirm),
	}
	chat, _ := Seal(offer.Keys.SendChat, []byte("chat"), []byte(`{"n":"alice","x":"secret words"}`))
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
	if _, err := rand.Read(make([]byte, 1)); err != nil {
		t.Fatal(err)
	}
}
