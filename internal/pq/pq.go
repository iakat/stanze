// Package pq is the post-quantum end-to-end key agreement and payload
// protection used by the browser client of this build.
//
// The construction is a hybrid of X25519 and ML-KEM-768 (FIPS 203): a
// classical Diffie-Hellman secret and a KEM secret are concatenated and run
// through HKDF-SHA256, so an attacker has to break both to recover the keys.
// The handshake is symmetric in shape: for every pair of peers the lower peer
// id initiates, the higher one answers. Neither the signaling server nor a
// passive network observer ever sees a secret.
package pq

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/mlkem"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
)

// Protocol is mixed into every transcript, so a future version can never
// share keys with this one.
const Protocol = "pq-e2e v1"

const (
	X25519Size = 32

	// mediaKeySize is the AES-256 key size.
	mediaKeySize = 32

	// okmSize is the amount of key material derived per pair:
	// media i->r, media r->i, chat i->r, chat r->i, sas seed.
	okmSize = 4*mediaKeySize + 8

	sasBytes = 8
)

var (
	ErrShape = errors.New("pq: malformed key material")
	ErrAuth  = errors.New("pq: authentication failed")
	ErrRole  = errors.New("pq: wrong handshake role")
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// Identity is a peer's long-term, per-page-load key material. It never leaves
// the browser: the client generates it in WebAssembly and keeps the secret
// halves in JavaScript memory.
type Identity struct {
	XPub []byte // 32 bytes, X25519
	XSk  []byte // 32 bytes, X25519
	EK   []byte // 1184 bytes, ML-KEM-768 encapsulation key
	DK   []byte // 64 bytes, ML-KEM-768 decapsulation key seed
}

// Public is the part of an Identity that is broadcast through signaling.
type Public struct {
	X   []byte
	KEM []byte
}

// NewIdentity draws a fresh X25519 key and ML-KEM-768 key pair.
func NewIdentity() (*Identity, error) {
	x, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	k, err := mlkem.GenerateKey768()
	if err != nil {
		return nil, err
	}
	return &Identity{
		XPub: x.PublicKey().Bytes(),
		XSk:  x.Bytes(),
		EK:   k.EncapsulationKey().Bytes(),
		DK:   k.Bytes(),
	}, nil
}

// Public returns the broadcast half of an identity.
func (i *Identity) Public() Public {
	return Public{X: i.XPub, KEM: i.EK}
}

// Keys are the four directional secrets of one peer pair, plus the short
// authentication string the two people may compare out of band.
type Keys struct {
	SendMedia []byte // AES-256-GCM key for frames this side sends
	RecvMedia []byte // AES-256-GCM key for frames this side receives
	SendChat  []byte // AES-256-GCM key for chat this side sends
	RecvChat  []byte // AES-256-GCM key for chat this side receives
	SAS       string // 13 lowercase base32 characters (64 bits)
}

// Offer is what the initiator sends: a fresh X25519 public key and the
// ML-KEM-768 ciphertext. Both are public.
type Offer struct {
	EPK        []byte // ephemeral X25519 public key, 32 bytes
	CT         []byte // ML-KEM-768 ciphertext, 1088 bytes
	Keys       Keys
	Confirm    []byte // key confirmation tag for the responder to verify
	Transcript []byte
}

// AcceptResult is the responder's view of the same handshake.
type AcceptResult struct {
	Keys       Keys
	Confirm    []byte
	Transcript []byte
}

// Initiate runs the initiator half of the handshake against the responder's
// broadcast public key. The caller must use the lower of the two peer ids as
// initiatorID; both sides derive the same transcript from that order.
func Initiate(initiatorID, responderID string, initiatorPub, responderPub Public) (*Offer, error) {
	if initiatorID >= responderID {
		return nil, fmt.Errorf("%w: initiator id must sort first", ErrRole)
	}
	if len(initiatorPub.X) != X25519Size || len(responderPub.X) != X25519Size ||
		len(initiatorPub.KEM) != mlkem.EncapsulationKeySize768 ||
		len(responderPub.KEM) != mlkem.EncapsulationKeySize768 {
		return nil, ErrShape
	}
	peerX, err := ecdh.X25519().NewPublicKey(responderPub.X)
	if err != nil {
		return nil, err
	}
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	ssDH, err := eph.ECDH(peerX)
	if err != nil {
		return nil, err
	}
	ek, err := mlkem.NewEncapsulationKey768(responderPub.KEM)
	if err != nil {
		return nil, err
	}
	ssKEM, ct := ek.Encapsulate()
	epk := eph.PublicKey().Bytes()

	tr := transcript(initiatorID, responderID, initiatorPub, responderPub, epk, ct)
	okm, err := derive(ssDH, ssKEM, tr)
	if err != nil {
		return nil, err
	}
	keys := splitKeys(okm, true)
	return &Offer{
		EPK:        epk,
		CT:         ct,
		Keys:       keys,
		Confirm:    confirmation(keys.SendMedia, tr),
		Transcript: tr,
	}, nil
}

// Accept runs the responder half. The responder needs its own identity to
// decapsulate and to complete the X25519 half.
func Accept(responderID, initiatorID string, self *Identity, initiatorPub, responderPub Public, epk, ct []byte) (*AcceptResult, error) {
	if initiatorID >= responderID {
		return nil, fmt.Errorf("%w: initiator id must sort first", ErrRole)
	}
	if self == nil || len(self.XSk) != X25519Size || len(self.DK) != mlkem.SeedSize {
		return nil, ErrShape
	}
	if len(epk) != X25519Size || len(ct) != mlkem.CiphertextSize768 {
		return nil, ErrShape
	}
	eph, err := ecdh.X25519().NewPublicKey(epk)
	if err != nil {
		return nil, err
	}
	xsk, err := ecdh.X25519().NewPrivateKey(self.XSk)
	if err != nil {
		return nil, err
	}
	ssDH, err := xsk.ECDH(eph)
	if err != nil {
		return nil, err
	}
	dk, err := mlkem.NewDecapsulationKey768(self.DK)
	if err != nil {
		return nil, err
	}
	// FIPS 203 implicit rejection: a corrupted ciphertext yields a wrong
	// secret without an error. The key confirmation catches that.
	ssKEM, err := dk.Decapsulate(ct)
	if err != nil {
		return nil, err
	}

	tr := transcript(initiatorID, responderID, initiatorPub, responderPub, epk, ct)
	okm, err := derive(ssDH, ssKEM, tr)
	if err != nil {
		return nil, err
	}
	keys := splitKeys(okm, false)
	return &AcceptResult{
		Keys:       keys,
		Confirm:    confirmation(keys.SendMedia, tr),
		Transcript: tr,
	}, nil
}

// VerifyConfirm checks the other side's key confirmation using the key this
// side uses to receive that direction.
func VerifyConfirm(keys Keys, tr, tag []byte) bool {
	return hmac.Equal(confirmation(keys.RecvMedia, tr), tag)
}

func confirmation(key, tr []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(Protocol))
	m.Write([]byte(" confirm"))
	m.Write(tr)
	return m.Sum(nil)[:16]
}

func transcript(initiatorID, responderID string, initiatorPub, responderPub Public, epk, ct []byte) []byte {
	h := sha256.New()
	w := func(b []byte) {
		var l [4]byte
		binary.BigEndian.PutUint32(l[:], uint32(len(b)))
		h.Write(l[:])
		h.Write(b)
	}
	w([]byte(Protocol))
	w([]byte(initiatorID))
	w([]byte(responderID))
	w(initiatorPub.X)
	w(initiatorPub.KEM)
	w(responderPub.X)
	w(responderPub.KEM)
	w(epk)
	w(ct)
	return h.Sum(nil)
}

func derive(ssDH, ssKEM, tr []byte) ([]byte, error) {
	ikm := make([]byte, 0, len(ssDH)+len(ssKEM))
	ikm = append(ikm, ssDH...)
	ikm = append(ikm, ssKEM...)
	return hkdf.Key(sha256.New, ikm, tr, Protocol+" keys", okmSize)
}

func splitKeys(okm []byte, initiator bool) Keys {
	i2rMedia := okm[0:32]
	r2iMedia := okm[32:64]
	i2rChat := okm[64:96]
	r2iChat := okm[96:128]
	sas := okm[128:136]
	k := Keys{SAS: base32Lower(sas)}
	if initiator {
		k.SendMedia, k.RecvMedia = i2rMedia, r2iMedia
		k.SendChat, k.RecvChat = i2rChat, r2iChat
	} else {
		k.SendMedia, k.RecvMedia = r2iMedia, i2rMedia
		k.SendChat, k.RecvChat = r2iChat, i2rChat
	}
	return k
}

func base32Lower(b []byte) string {
	s := b32.EncodeToString(b)
	for i := 0; i < len(s); i++ {
		if s[i] >= 'A' && s[i] <= 'Z' {
			s = s[:i] + string(s[i]+32) + s[i+1:]
		}
	}
	return s
}

// Seal protects one payload with AES-256-GCM and a fresh random 96 bit nonce.
// The output is version byte, nonce, ciphertext and tag, so it is self
// describing and needs no counter state on either side.
func Seal(key, aad, plaintext []byte) ([]byte, error) {
	if len(key) != mediaKeySize {
		return nil, ErrShape
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	iv := make([]byte, aead.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		return nil, err
	}
	out := make([]byte, 1+len(iv), 1+len(iv)+len(plaintext)+aead.Overhead())
	out[0] = 1
	copy(out[1:], iv)
	return aead.Seal(out, iv, plaintext, aad), nil
}

// Open reverses Seal. A wrong key, a modified byte or a wrong AAD all fail the
// authentication tag.
func Open(key, aad, blob []byte) ([]byte, error) {
	if len(key) != mediaKeySize {
		return nil, ErrShape
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(blob) < 1+aead.NonceSize()+aead.Overhead() || blob[0] != 1 {
		return nil, ErrAuth
	}
	iv := blob[1 : 1+aead.NonceSize()]
	return aead.Open(nil, iv, blob[1+aead.NonceSize():], aad)
}
