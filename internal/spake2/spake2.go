// Package spake2 is SPAKE2, the balanced password-authenticated key exchange of
// RFC 9382, over the P256-SHA256-HKDF-HMAC ciphersuite.
//
// Two parties that share a password derive a strong key without sending the
// password, and each proves to the other that it knows it. Both parts are
// known before the first message, so the asymmetric suite is used: A blinds
// with M, B with N, and the two identities ride in the transcript.
//
// The deprecated crypto/elliptic calls are used on purpose: they are the ones
// that expose point addition, and the P-256 arithmetic underneath is the
// constant time nistec code.
package spake2

import (
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math/big"
)

var curve = elliptic.P256()

const (
	pointLen  = 65 // uncompressed P-256 point
	scalarLen = 32 // the group order fits in 32 bytes
)

// The two blinding points of the P-256 suite, Table 1 of RFC 9382, compressed.
// They are the ones the test vectors use.
var (
	seedM = mustDecompress("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f")
	seedN = mustDecompress("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49")
)

// point is one curve element in affine coordinates.
type point struct{ x, y *big.Int }

func mustDecompress(h string) point {
	raw, err := hex.DecodeString(h)
	if err != nil {
		panic("spake2: bad suite constant: " + err.Error())
	}
	x, y := elliptic.UnmarshalCompressed(curve, raw)
	if x == nil {
		panic("spake2: suite constant is not a point")
	}
	return point{x, y}
}

// ErrNotOnCurve aborts an exchange on a peer element that is not a point. The
// RFC requires the abort: a sloppy element is an attack, not a typo.
var ErrNotOnCurve = errors.New("spake2: peer element is not a group point")

// Passphrase turns a password into w, the scalar both sides share. The digest
// is longer than the group order on purpose, and the work factor belongs to the
// caller: a higher count makes each guess cost more.
func Passphrase(pass, salt []byte, iter int) (*big.Int, error) {
	if len(pass) == 0 {
		return nil, errors.New("spake2: empty passphrase")
	}
	sum, err := pbkdf2.Key(sha256.New, string(pass), salt, iter, 64)
	if err != nil {
		return nil, err
	}
	return new(big.Int).Mod(new(big.Int).SetBytes(sum), curve.Params().N), nil
}

// Role says which part a side plays. The two differ only in the blinding point:
// A adds w*M to its own point and subtracts w*N from the peer's, and B the
// other way round.
type Role byte

// The two roles. The initiator of the meeting is always A, so the pair does not
// have to argue about it.
const (
	A Role = 'A'
	B Role = 'B'
)

// Side is one party of one exchange. A Side is used once.
type Side struct {
	role    Role
	w       *big.Int
	scalar  *big.Int
	a, b    []byte // identities, A first
	mine    []byte // our point, pA or pB
	theirs  []byte // the peer's point
	shared  []byte // the raw shared point K
	peerKey []byte // the MAC key for the peer's confirmation
	done    bool
}

func (s *Side) ownBlind() (x, y *big.Int) {
	if s.role == A {
		return curve.ScalarMult(seedM.x, seedM.y, s.w.Bytes())
	}
	return curve.ScalarMult(seedN.x, seedN.y, s.w.Bytes())
}

func (s *Side) peerBlind() (x, y *big.Int) {
	if s.role == A {
		return curve.ScalarMult(seedN.x, seedN.y, s.w.Bytes())
	}
	return curve.ScalarMult(seedM.x, seedM.y, s.w.Bytes())
}

// Start draws a fresh scalar and returns the side, ready to send Message.
func Start(role Role, w *big.Int, a, b []byte) (*Side, error) {
	scalar, err := rand.Int(rand.Reader, curve.Params().N)
	if err != nil {
		return nil, err
	}
	return startWith(role, w, scalar, a, b)
}

// startWith is the deterministic form the RFC test vectors need: the scalar is
// supplied instead of drawn.
func startWith(role Role, w, scalar *big.Int, a, b []byte) (*Side, error) {
	s := &Side{role: role, w: w, scalar: scalar, a: a, b: b}
	bx, by := s.ownBlind()
	mx, my := curve.ScalarBaseMult(scalar.Bytes())
	x, y := curve.Add(mx, my, bx, by)
	s.mine = elliptic.Marshal(curve, x, y)
	return s, nil
}

// Message is the 65 byte point this side sends.
func (s *Side) Message() []byte { return append([]byte(nil), s.mine...) }

// Finish takes the peer's point and returns the key Ke plus this side's
// confirmation tag.
func (s *Side) Finish(theirs []byte) (ke, tag []byte, err error) {
	if s.done || len(theirs) != pointLen {
		return nil, nil, ErrNotOnCurve
	}
	px, py := elliptic.Unmarshal(curve, theirs)
	if px == nil {
		return nil, nil, ErrNotOnCurve
	}
	// K = x*(pB - w*N) for A, and y*(pA - w*M) for B. The subtraction is an
	// addition of the negated point, which for P-256 is (x, p-y).
	bx, by := s.peerBlind()
	negY := new(big.Int).Sub(curve.Params().P, by)
	dx, dy := curve.Add(px, py, bx, negY)
	sx, sy := curve.ScalarMult(dx, dy, s.scalar.Bytes())
	if sx == nil {
		return nil, nil, ErrNotOnCurve
	}
	s.theirs = append([]byte(nil), theirs...)
	s.shared = elliptic.Marshal(curve, sx, sy)
	s.done = true
	return s.keys()
}

// keys splits Hash(TT) into Ke and Ka and derives the two confirmation keys,
// keeping the peer's half for Verify.
func (s *Side) keys() (ke, tag []byte, err error) {
	tt := s.transcript()
	sum := sha256.Sum256(tt)
	half := len(sum) / 2
	ka := sum[half:]
	kcs, err := hkdf.Key(sha256.New, ka, nil, "ConfirmationKeys", len(sum))
	if err != nil {
		return nil, nil, err
	}
	// A confirms with the first half, B with the second, and each side keeps
	// the other half to check the peer. RFC 9382 section 4.
	mine, theirs := kcs[:half], kcs[half:]
	if s.role == B {
		mine, theirs = theirs, mine
	}
	s.peerKey = theirs
	mac := hmac.New(sha256.New, mine)
	mac.Write(tt)
	return sum[:half], mac.Sum(nil), nil
}

// Verify checks the peer's confirmation tag in constant time.
func (s *Side) Verify(tag []byte) bool {
	if !s.done || len(tag) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, s.peerKey)
	mac.Write(s.transcript())
	return subtle.ConstantTimeCompare(mac.Sum(nil), tag) == 1
}

// transcript is len(A)||A||len(B)||B||len(pA)||pA||len(pB)||pB||len(K)||K||
// len(w)||w, every length an eight byte little-endian count (RFC 9382 3.1).
func (s *Side) transcript() []byte {
	var out []byte
	add := func(b []byte) {
		var n [8]byte
		binary.LittleEndian.PutUint64(n[:], uint64(len(b)))
		out = append(out, n[:]...)
		out = append(out, b...)
	}
	// The transcript always names A's point first, whatever side we are.
	pA, pB := s.mine, s.theirs
	if s.role == B {
		pA, pB = pB, pA
	}
	add(s.a)
	add(s.b)
	add(pA)
	add(pB)
	add(s.shared)
	add(padScalar(s.w))
	return out
}

// padScalar encodes w in the width of the group order, so the encoding length
// never says anything about the value.
func padScalar(w *big.Int) []byte {
	out := make([]byte, scalarLen)
	w.FillBytes(out)
	return out
}
