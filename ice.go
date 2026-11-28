package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/logging"
	"github.com/pion/stun/v4"
	"github.com/pion/turn/v5"
)

// iceServersFor builds the ICE server list handed to a client at request time.
// STUN is answered by the embedded relay itself (see stunMux); TURN is offered
// with a fresh ephemeral credential derived from the shared secret, so the
// relay can be used as a fallback. Neither needs a third party.
//
// A URL must name a real port, or a browser refuses the whole list, so nothing
// is offered while the relay is not running or its port is not known yet.
func iceServersFor(cfg *Config, tag string) ([]iceServer, error) {
	var out []iceServer
	if len(cfg.StunURLs) > 0 {
		out = append(out, iceServer{URLs: cfg.StunURLs})
	}
	if !cfg.turnEnabled() {
		return out, nil
	}

	user, pass, err := turn.GenerateLongTermTURNRESTCredentials(cfg.TurnSecret, tag, cfg.TurnTTL)
	if err != nil {
		return out, err
	}

	host := cfg.TurnPublicIP
	if ip := net.ParseIP(host); ip != nil && strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	urls := []string{fmt.Sprintf("turn:%s:%d?transport=udp", host, cfg.TurnPort)}
	if cfg.TurnTCPPort > 0 {
		urls = append(urls, fmt.Sprintf("turn:%s:%d?transport=tcp", host, cfg.TurnTCPPort))
	}
	urls = append(urls, cfg.TurnURLs...)
	out = append(out, iceServer{URLs: urls, Username: user, Credential: pass})
	return out, nil
}

// boundPort is the port a packet conn listens on, or 0 when the address names
// none, as a unix socket or an unknown network does.
func boundPort(c net.PacketConn) int {
	if ua, ok := c.LocalAddr().(*net.UDPAddr); ok {
		return ua.Port
	}
	return 0
}

// setTurnPort writes the port the relay actually listens on into the config,
// before any goroutine can read it, and rebuilds the STUN list from it: a port
// of 0 is a request for a free one, and the join has to advertise the port the
// kernel chose, not the zero that was asked for.
func setTurnPort(cfg *Config, port int) {
	cfg.TurnPort = port
	cfg.setEmbeddedStun()
}

func randomUserTag() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		// The fallback still has to differ per connection, but it must not read
		// as a clock: a readable time in the relay username links an allocation
		// to a join minute.
		sum := sha256.Sum256([]byte(strconv.FormatInt(time.Now().UnixNano(), 36)))
		b = sum[:6]
	}
	return fmt.Sprintf("%x", b)
}

// startTURN runs the embedded TURN server in the same process. No media is
// terminated here: it only relays UDP packets between peers that cannot reach
// each other directly.
func startTURN(cfg *Config, log *slog.Logger) (*turn.Server, error) {
	relay := &turn.RelayAddressGeneratorPortRange{
		RelayAddress: net.ParseIP(cfg.TurnPublicIP),
		Address:      "0.0.0.0",
		MinPort:      uint16(cfg.TurnMinPort),
		MaxPort:      uint16(cfg.TurnMaxPort),
	}

	udpConn, err := net.ListenPacket("udp4", fmt.Sprintf("0.0.0.0:%d", cfg.TurnPort))
	if err != nil {
		return nil, fmt.Errorf("turn udp listen: %w", err)
	}
	// The port is settled before a single datagram is served, so the config a
	// join reads is the one that names the socket.
	if port := boundPort(udpConn); port > 0 && port != cfg.TurnPort {
		setTurnPort(cfg, port)
	}

	relayGrants = newRelayGrants(cfg.MaxPeers)
	turnCfg := turn.ServerConfig{
		Realm:       cfg.TurnRealm,
		AuthHandler: turn.LongTermTURNRESTAuthHandler(cfg.TurnSecret, nil),
		// A credential is minted once per socket and then used for every pair
		// of that socket, so the ceiling is maxPeers-1 and the key is the
		// credential, never the host: a house behind one NAT may hold as many
		// relays as it has guests. Nothing is counted per address here.
		QuotaHandler: func(username, realm string, srcAddr net.Addr) bool {
			return relayGrants.allow(username)
		},
		// The grant count is kept honest by the lifecycle, not by the request:
		// a count that only went up in the quota handler and never down would
		// lock a credential out after one allocation that failed. Created and
		// deleted are the only two events that move it.
		EventHandler: turn.EventHandler{
			OnAllocationCreated: func(_, _ net.Addr, _, userID, _ string, _ net.Addr, _ int) {
				relayGrants.created(userID)
			},
			OnAllocationDeleted: func(_, _ net.Addr, _, userID, _ string) {
				relayGrants.deleted(userID)
			},
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn:            stunMux{udpConn},
			RelayAddressGenerator: relay,
		}},
		LoggerFactory: logging.NewDefaultLoggerFactory(),
	}

	if cfg.TurnTCPPort > 0 {
		tcpListener, err := net.Listen("tcp4", fmt.Sprintf("0.0.0.0:%d", cfg.TurnTCPPort))
		if err != nil {
			udpConn.Close()
			return nil, fmt.Errorf("turn tcp listen: %w", err)
		}
		turnCfg.ListenerConfigs = []turn.ListenerConfig{{
			Listener:              tcpListener,
			RelayAddressGenerator: relay,
		}}
	}

	srv, err := turn.NewServer(turnCfg)
	if err != nil {
		udpConn.Close()
		return nil, fmt.Errorf("turn server: %w", err)
	}
	log.Info("turn relay listening",
		"udp", cfg.TurnPort,
		"tcp", cfg.TurnTCPPort,
		"relay_ports", fmt.Sprintf("%d-%d", cfg.TurnMinPort, cfg.TurnMaxPort),
		"public_ip", cfg.TurnPublicIP,
	)
	return srv, nil
}

// relayGrants caps how many relays one credential may open. A credential is
// minted once per socket and then used for every pair of that socket, so its
// honest ceiling is the number of pairs one guest can have: maxPeers-1. The
// key is the credential, never the host, so one address may hold as many
// relays as it has guests and a house behind one NAT is not a suspect. The
// port range is the real ceiling on relays alive at once.
//
// The count moves on allocation created and deleted, never on the request: a
// request that is refused (a bad credential, a port out of range) must not use
// up the grant.
// relayGrants is set once at start, before any datagram is served, so the
// quota handler and the event handler read the same object.
var relayGrants *allocQuota

func newRelayGrants(maxPeers int) *allocQuota {
	if maxPeers < 2 {
		maxPeers = 2
	}
	return newAllocQuota(maxPeers-1, 10*time.Minute)
}

// allocQuota counts live relay allocations per key.
//
// A key is a credential, and the entry is forgotten as soon as its last
// allocation closes: a count that only went up would lock a credential out
// after one allocation that failed, and a map that was wiped whole at a size
// limit would hand a fresh allowance to everyone at once. An entry that has
// been idle is dropped by a sweep, so the map cannot grow without bound from
// credentials that were minted and never used.
type allocQuota struct {
	mu    sync.Mutex
	max   int
	idle  time.Duration
	seen  map[string]*allocEntry
	swept time.Time
}

type allocEntry struct {
	live int
	last time.Time // last time this entry moved up or down
}

func newAllocQuota(max int, idle time.Duration) *allocQuota {
	return &allocQuota{max: max, idle: idle, seen: make(map[string]*allocEntry), swept: time.Now()}
}

// allow reports whether key may open another allocation. It counts nothing:
// the count moves on created and deleted, so a request that is never granted
// (a bad credential, a refused port) cannot use up a slot.
func (q *allocQuota) allow(key string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	now := time.Now()
	q.sweepLocked(now)
	e := q.seen[key]
	if e == nil {
		return true
	}
	return e.live < q.max
}

// created books one more allocation for key.
func (q *allocQuota) created(key string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	e := q.seen[key]
	if e == nil {
		e = &allocEntry{}
		q.seen[key] = e
	}
	e.live++
	e.last = time.Now()
}

// deleted returns one allocation slot for key. The entry stays until it has
// been idle, so a client that reconnects at once finds its count again.
func (q *allocQuota) deleted(key string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	e := q.seen[key]
	if e == nil {
		return
	}
	if e.live > 0 {
		e.live--
	}
	e.last = time.Now()
	if e.live == 0 {
		delete(q.seen, key)
	}
}

// live is the number of allocations held by key. It is for tests.
func (q *allocQuota) live(key string) int {
	q.mu.Lock()
	defer q.mu.Unlock()
	if e := q.seen[key]; e != nil {
		return e.live
	}
	return 0
}

// sweepLocked drops empty entries that have been idle for idle. It runs at most
// once per idle, and only while the map is worth looking at.
func (q *allocQuota) sweepLocked(now time.Time) {
	if len(q.seen) < 256 || now.Sub(q.swept) < q.idle {
		return
	}
	q.swept = now
	for k, e := range q.seen {
		if e.live == 0 && now.Sub(e.last) > 2*q.idle {
			delete(q.seen, k)
		}
	}
}

// stunMux answers STUN binding requests on the relay socket and passes every
// other datagram to the TURN server. One open UDP port therefore serves both,
// so a client learns its public address from us and contacts no third party.
type stunMux struct {
	net.PacketConn
}

func (m stunMux) ReadFrom(p []byte) (int, net.Addr, error) {
	for {
		n, addr, err := m.PacketConn.ReadFrom(p)
		if err != nil {
			return n, addr, err
		}
		to, ok := addr.(*net.UDPAddr)
		if !ok || n < 20 || !stun.IsMessage(p[:n]) ||
			binary.BigEndian.Uint16(p) != stun.BindingRequest.Value() {
			return n, addr, nil
		}
		res := stun.MustBuild(stun.BindingSuccess,
			&stun.XORMappedAddress{IP: to.IP, Port: to.Port})
		copy(res.TransactionID[:], p[8:20])
		res.WriteHeader()
		_ = stun.Fingerprint.AddTo(res)
		_, _ = m.PacketConn.WriteTo(res.Raw, to)
	}
}
