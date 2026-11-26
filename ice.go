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

// iceServersFor builds the ICE server list handed to a client at join time.
// STUN is answered by the embedded relay itself (see stunMux); TURN is offered
// with a fresh ephemeral credential derived from the shared secret, so the
// relay can be used as a fallback. Neither needs a third party.
//
// A URL must name a real port, or a browser refuses the whole list, so nothing
// is offered while the relay is not running or its port is not known yet.
func iceServersFor(cfg *Config) ([]iceServer, error) {
	var out []iceServer
	if len(cfg.StunURLs) > 0 {
		out = append(out, iceServer{URLs: cfg.StunURLs})
	}
	if !cfg.turnEnabled() {
		return out, nil
	}

	user, pass, err := turn.GenerateLongTermTURNRESTCredentials(cfg.TurnSecret, randomUserTag(), cfg.TurnTTL)
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

	turnCfg := turn.ServerConfig{
		Realm:       cfg.TurnRealm,
		AuthHandler: turn.LongTermTURNRESTAuthHandler(cfg.TurnSecret, nil),
		QuotaHandler: func(username, realm string, srcAddr net.Addr) bool {
			return turnQuota.allow(username)
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

// turnQuota is a blunt per-credential allocation cap: every join gets its own
// username, so one client cannot open unlimited relay allocations.
var turnQuota = &quotaCounter{max: 8, seen: make(map[string]int)}

type quotaCounter struct {
	mu   sync.Mutex
	max  int
	seen map[string]int
}

func (q *quotaCounter) allow(user string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.seen) > 10000 {
		q.seen = make(map[string]int)
	}
	q.seen[user]++
	return q.seen[user] <= q.max
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
