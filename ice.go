package main

import (
	"crypto/rand"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"
)

// iceServersFor builds the ICE server list handed to a client at join time.
// STUN is always offered; TURN is offered with a fresh ephemeral credential
// derived from the shared secret, so the relay can be used as a fallback.
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

func randomUserTag() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
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

	turnCfg := turn.ServerConfig{
		Realm:       cfg.TurnRealm,
		AuthHandler: turn.LongTermTURNRESTAuthHandler(cfg.TurnSecret, nil),
		QuotaHandler: func(username, realm string, srcAddr net.Addr) bool {
			return turnQuota.allow(username)
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn:            udpConn,
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
