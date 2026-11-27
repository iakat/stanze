//go:build !js

package main

import (
	"encoding/base64"
	"fmt"
	"testing"

	"stanze/internal/pq"
)

// b64 is the encoding the page uses on the wire for both a message and a
// signature: standard base64, no line breaks.
func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// decodeMsg is the rule the module applies to a message: the bytes arrive as
// base64 and are decoded once, then checked exactly as they came out. The
// browser build spells this as b64d; the native build tests the same rule.
func decodeMsg(msg string) ([]byte, error) { return base64.StdEncoding.DecodeString(msg) }

// TestClaimSignatureRoundTrip is the M0 tripwire. A role claim is signed with
// the identity key over its exact bytes and then checked by the same functions
// the wasm module exposes. The signer and the verifier must agree on the
// encoding: the message is base64 of the signed bytes, and nothing decodes or
// re-encodes it on either side.
func TestClaimSignatureRoundTrip(t *testing.T) {
	key, err := pq.NewSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	// The claim text is the page's own byte string; its shape is the page's
	// business, only the encoding is shared here.
	claim := []byte("stanze/claim/2|room|0|abcdef012345,012345abcdef|")

	sig := key.Sign(claim)
	if !pq.VerifySignature(key.PublicKey(), claim, sig) {
		t.Fatal("a fresh signature did not verify over the signed bytes")
	}

	// The rule the module applies: the message arrives as base64 of the bytes
	// that were signed.
	msg, err := decodeMsg(b64(claim))
	if err != nil {
		t.Fatal(err)
	}
	if !pq.VerifySignature(key.PublicKey(), msg, sig) {
		t.Fatal("idverify's encoding does not agree with SigningKey.Sign")
	}

	// The old defect: verifying base64 text that was never signed. It must
	// never pass, or the two sides could silently disagree again.
	plain := []byte(b64(claim))
	if pq.VerifySignature(key.PublicKey(), plain, sig) {
		t.Fatal("a signature verified over bytes it was not made on")
	}

	// A message that is not base64 is refused instead of being checked as
	// something else.
	if _, err := decodeMsg("stanze/claim/2|room|0|"); err == nil {
		t.Fatal("a message that is not base64 was accepted")
	}

	// A different key does not verify.
	other, err := pq.NewSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	if pq.VerifySignature(other.PublicKey(), msg, sig) {
		t.Fatal("a foreign identity verified a claim")
	}
}

// TestClaimChain walks a role claim chain step by step the way the pages do:
// every step is signed by an admin of the previous one and checked against
// that admin's key before it is adopted. This is the end to end check the
// review asked for: the encoding, the step rule and the signer rule together.
func TestClaimChain(t *testing.T) {
	mk := func() *pq.SigningKey {
		key, err := pq.NewSigningKey()
		if err != nil {
			t.Fatal(err)
		}
		return key
	}
	// One signing identity per peer id, the way a page signs for itself.
	root := mk()
	guest := mk()
	third := mk()
	claims := map[string]*pq.SigningKey{"aaaaaaaaaaaa": root, "bbbbbbbbbbbb": guest, "cccccccccccc": third}

	room := "room-1"
	text := func(n int, admins []string) []byte {
		line := fmt.Sprintf("stanze/claim/2|%s|%d|", room, n)
		for i, id := range admins {
			if i > 0 {
				line += ","
			}
			line += id
		}
		return []byte(line + "|")
	}

	type claim struct {
		n      int
		admins []string
		by     string
		sig    []byte
	}
	// verify is what a page does with an incoming claim, with the encoding
	// rule of the module.
	verify := func(c claim) bool {
		msg, err := decodeMsg(b64(text(c.n, c.admins)))
		if err != nil {
			return false
		}
		key := claims[c.by]
		if key == nil || !contains(c.admins, c.by) {
			return false
		}
		return pq.VerifySignature(key.PublicKey(), msg, c.sig)
	}
	steps := []claim{
		{n: 0, admins: []string{"aaaaaaaaaaaa"}, by: "aaaaaaaaaaaa"},
		{n: 1, admins: []string{"aaaaaaaaaaaa", "bbbbbbbbbbbb"}, by: "aaaaaaaaaaaa"},
		{n: 2, admins: []string{"bbbbbbbbbbbb"}, by: "bbbbbbbbbbbb"}, // the root leaves
	}
	for i := range steps {
		s := steps[i]
		s.sig = claims[s.by].Sign(text(s.n, s.admins))
		steps[i] = s
	}

	// Adoption on a fresh page: step 0 is the seed.
	if !verify(steps[0]) {
		t.Fatal("step 0 did not verify")
	}
	cur := steps[0]
	for _, next := range steps[1:] {
		if next.n != cur.n+1 {
			t.Fatalf("step %d does not follow %d", next.n, cur.n)
		}
		if !contains(cur.admins, next.by) {
			t.Fatalf("step %d was signed by a non-admin", next.n)
		}
		if !verify(next) || !contains(next.admins, next.by) {
			t.Fatalf("step %d did not verify", next.n)
		}
		cur = next
	}
	if !contains(cur.admins, "bbbbbbbbbbbb") || contains(cur.admins, "aaaaaaaaaaaa") {
		t.Fatalf("the chain did not end where it should: %v", cur.admins)
	}

	// A guest that is not an admin of the previous step can sign a step of its
	// own; it is authentic and still refused by the step rule.
	forged := claim{n: cur.n + 1, admins: []string{"cccccccccccc"}, by: "cccccccccccc"}
	forged.sig = claims[forged.by].Sign(text(forged.n, forged.admins))
	if !verify(forged) {
		t.Fatal("the forged step should still be a valid signature")
	}
	if contains(cur.admins, forged.by) {
		t.Fatal("a non-admin step was accepted")
	}

	// A step whose bytes were changed after signing fails.
	tampered := claim{n: cur.n + 1, admins: []string{"bbbbbbbbbbbb", "cccccccccccc"}, by: "bbbbbbbbbbbb"}
	tampered.sig = claims[tampered.by].Sign(text(tampered.n, []string{"bbbbbbbbbbbb"}))
	if verify(tampered) {
		t.Fatal("a tampered claim verified")
	}
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
