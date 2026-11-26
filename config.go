package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds everything that can be set from the command line or the
// environment. Flags win over environment variables.
type Config struct {
	Listen         string
	Debug          bool
	StunURLs       []string
	stunExplicit   bool // an operator gave the STUN list; never replace it
	Turn           bool
	TurnPublicIP   string
	TurnIPAuto     bool
	TurnPort       int
	TurnTCPPort    int
	TurnRealm      string
	TurnSecret     string
	TurnSecretAuto bool
	TurnTTL        time.Duration
	TurnURLs       []string
	TurnMinPort    int
	TurnMaxPort    int
	MaxPeers       int
	MaxRooms       int
	MaxMsgBytes    int64
	BehindProxy    bool
	StaticDir      string
	DocsDir        string
	VoskDir        string
	OmniDir        string
	AllowedOrigin  string
}

func envStr(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return def
}

func envDur(key string, def time.Duration) time.Duration {
	if v, ok := os.LookupEnv(key); ok {
		if d, err := time.ParseDuration(strings.TrimSpace(v)); err == nil {
			return d
		}
	}
	return def
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

type stringList struct {
	values *[]string
}

func (s stringList) String() string {
	if s.values == nil {
		return ""
	}
	return strings.Join(*s.values, ",")
}
func (s stringList) Set(v string) error {
	for _, p := range splitList(v) {
		*s.values = append(*s.values, p)
	}
	return nil
}

func loadConfig(args []string) (*Config, error) {
	cfg := &Config{}

	stun := splitList(envStr("STUN_URLS", ""))
	turnURLs := splitList(envStr("TURN_URLS", ""))
	var stunFlags []string

	fs := flag.NewFlagSet("stanze", flag.ContinueOnError)
	fs.StringVar(&cfg.Listen, "listen", envStr("LISTEN", ":8095"), "address to listen on for HTTP (put a TLS proxy in front for production)")
	fs.BoolVar(&cfg.Debug, "debug", envStr("DEBUG", "") != "", "verbose logging (never logs room ids)")
	fs.Var(stringList{&stunFlags}, "stun", "STUN URL handed to browsers (repeatable, comma separated; env STUN_URLS)")
	fs.BoolVar(&cfg.Turn, "turn", envStr("TURN", "1") != "0", "run the embedded relay and STUN (default on; env TURN=0 disables)")
	fs.StringVar(&cfg.TurnPublicIP, "turn-public-ip", envStr("TURN_PUBLIC_IP", ""), "public IP advertised to clients for the embedded TURN relay; empty takes the outbound address")
	fs.IntVar(&cfg.TurnPort, "turn-port", envInt("TURN_PORT", 3478), "UDP port for the embedded TURN server (0 = a free port at start)")
	fs.IntVar(&cfg.TurnTCPPort, "turn-tcp-port", envInt("TURN_TCP_PORT", 0), "optional TCP port for TURN (0 = off)")
	fs.StringVar(&cfg.TurnRealm, "turn-realm", envStr("TURN_REALM", "stanze"), "TURN realm")
	fs.StringVar(&cfg.TurnSecret, "turn-secret", envStr("TURN_SECRET", ""), "shared secret for ephemeral TURN credentials (env TURN_SECRET); empty makes a random one at each start")
	fs.DurationVar(&cfg.TurnTTL, "turn-ttl", envDur("TURN_TTL", 10*time.Minute), "lifetime of issued TURN credentials")
	fs.Var(stringList{&turnURLs}, "turn-url", "extra TURN URL to advertise, e.g. turns:example.com:5349?transport=tcp (repeatable; env TURN_URLS)")
	fs.IntVar(&cfg.TurnMinPort, "turn-min-port", envInt("TURN_MIN_PORT", 49200), "lowest relay port for TURN allocations")
	fs.IntVar(&cfg.TurnMaxPort, "turn-max-port", envInt("TURN_MAX_PORT", 49300), "highest relay port for TURN allocations")
	fs.IntVar(&cfg.MaxPeers, "max-peers", envInt("MAX_PEERS", 8), "maximum peers in one room")
	fs.IntVar(&cfg.MaxRooms, "max-rooms", envInt("MAX_ROOMS", 200), "maximum simultaneously existing rooms")
	fs.Int64Var(&cfg.MaxMsgBytes, "max-msg-bytes", int64(envInt("MAX_MSG_BYTES", 256*1024)), "maximum websocket message size in bytes")
	fs.BoolVar(&cfg.BehindProxy, "behind-proxy", envStr("BEHIND_PROXY", "") != "", "trust X-Forwarded-For for rate limiting (only behind a proxy you control)")
	fs.StringVar(&cfg.StaticDir, "static-dir", envStr("STATIC_DIR", ""), "serve the web client from this directory instead of the embedded copy")
	fs.StringVar(&cfg.DocsDir, "docs-dir", envStr("DOCS_DIR", ""), "serve QUEUE.md and DONE.md from this directory (empty disables the routes)")
	fs.StringVar(&cfg.VoskDir, "vosk-dir", envStr("VOSK_DIR", ""), "directory with vosk.js and model.tar.gz for the optional in-browser transcription (empty: the feature is not offered)")
	fs.StringVar(&cfg.OmniDir, "omni-dir", envStr("OMNI_DIR", ""), "directory with the sherpa-onnx wasm bundle and the Omnilingual ASR model for the optional multilingual transcription (empty: the feature is not offered)")
	fs.StringVar(&cfg.AllowedOrigin, "allowed-origin", envStr("ALLOWED_ORIGIN", ""), "extra allowed websocket Origin (default: same host only)")

	if err := fs.Parse(args); err != nil {
		return nil, err
	}

	// A -stun flag replaces the environment default instead of appending to it.
	if len(stunFlags) > 0 {
		stun = stunFlags
	}
	cfg.StunURLs = stun
	cfg.stunExplicit = len(stun) > 0
	cfg.TurnURLs = turnURLs

	// The relay and its STUN are on unless asked off. A missing secret is
	// replaced by a random one per start, and a missing address by the local
	// address the routing table would use (no packet is sent to find it).
	if !cfg.Turn {
		cfg.TurnSecret, cfg.TurnPublicIP = "", ""
	} else {
		if cfg.TurnSecret == "" {
			b := make([]byte, 32)
			if _, err := rand.Read(b); err != nil {
				return nil, fmt.Errorf("turn secret: %w", err)
			}
			cfg.TurnSecret, cfg.TurnSecretAuto = hex.EncodeToString(b), true
		}
		if cfg.TurnPublicIP == "" {
			cfg.TurnPublicIP, cfg.TurnIPAuto = outboundIP(), true
		}
	}

	// With no explicit STUN, use the embedded relay as the STUN endpoint. The
	// TURN server also answers Binding requests, so no third party is contacted.
	cfg.setEmbeddedStun()

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func (c *Config) validate() error {
	if c.Listen == "" {
		return errors.New("-listen must not be empty")
	}
	if c.MaxPeers < 2 {
		return fmt.Errorf("-max-peers must be at least 2 (got %d)", c.MaxPeers)
	}
	if c.MaxPeers > 32 {
		return fmt.Errorf("-max-peers above 32 makes the mesh pointless, refusing %d", c.MaxPeers)
	}
	if c.MaxRooms < 1 {
		return errors.New("-max-rooms must be positive")
	}
	if c.MaxMsgBytes < 4096 || c.MaxMsgBytes > 8*1024*1024 {
		return fmt.Errorf("-max-msg-bytes must be between 4096 and 8388608 (got %d)", c.MaxMsgBytes)
	}
	// The relay range has to be a real one: the allocation manager narrows the
	// two bounds to uint16, so a value outside a port would wrap into a range
	// nobody asked for. The listening port is checked too: 0 asks the kernel for
	// a free one, anything else must be a port, and a listening port inside the
	// relay range would collide with allocations on the same host.
	if c.TurnMinPort < 1 || c.TurnMinPort > 65535 {
		return fmt.Errorf("-turn-min-port must be between 1 and 65535 (got %d)", c.TurnMinPort)
	}
	if c.TurnMaxPort < 1 || c.TurnMaxPort > 65535 {
		return fmt.Errorf("-turn-max-port must be between 1 and 65535 (got %d)", c.TurnMaxPort)
	}
	if c.TurnMaxPort <= c.TurnMinPort {
		return errors.New("-turn-max-port must be greater than -turn-min-port")
	}
	if c.TurnPort < 0 || c.TurnPort > 65535 {
		return fmt.Errorf("-turn-port must be between 0 and 65535 (got %d)", c.TurnPort)
	}
	if c.TurnTCPPort < 0 || c.TurnTCPPort > 65535 {
		return fmt.Errorf("-turn-tcp-port must be between 0 and 65535 (got %d)", c.TurnTCPPort)
	}
	if c.turnWanted() {
		if c.TurnPort > 0 && c.TurnPort >= c.TurnMinPort && c.TurnPort <= c.TurnMaxPort {
			return fmt.Errorf("-turn-port %d is inside the relay range %d-%d", c.TurnPort, c.TurnMinPort, c.TurnMaxPort)
		}
		if c.TurnTCPPort > 0 && c.TurnTCPPort >= c.TurnMinPort && c.TurnTCPPort <= c.TurnMaxPort {
			return fmt.Errorf("-turn-tcp-port %d is inside the relay range %d-%d", c.TurnTCPPort, c.TurnMinPort, c.TurnMaxPort)
		}
	}
	if c.TurnTTL <= 0 {
		return fmt.Errorf("-turn-ttl must be positive (got %s)", c.TurnTTL)
	}
	if c.TurnTTL > time.Hour {
		return fmt.Errorf("-turn-ttl above an hour makes the relay a lasting credential, refusing %s", c.TurnTTL)
	}
	return nil
}

func (c *Config) turnEnabled() bool {
	return c.TurnPublicIP != "" && c.TurnSecret != "" && c.TurnPort != 0
}

// turnWanted reports whether the relay should run. It differs from
// turnEnabled only before the socket is bound: a port of 0 is a request for a
// free one, and the relay has to run to learn it.
func (c *Config) turnWanted() bool {
	return c.TurnPublicIP != "" && c.TurnSecret != "" && c.TurnPort >= 0
}

// setEmbeddedStun fills the STUN list with the embedded relay, unless the
// operator gave one. It runs again after the relay socket is bound, because a
// port of 0 is only known then; a URL of the relay is never a broken one, since
// :0 would name no port at all.
func (c *Config) setEmbeddedStun() {
	if c.stunExplicit || !c.turnEnabled() {
		return
	}
	host := c.TurnPublicIP
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if host == "" || c.TurnPort <= 0 {
		return
	}
	c.StunURLs = []string{fmt.Sprintf("stun:%s:%d", host, c.TurnPort)}
}

func (c *Config) logLevel() slog.Level {
	if c.Debug {
		return slog.LevelDebug
	}
	return slog.LevelInfo
}

// outboundIP returns the local address the routing table would use for the
// default route. A UDP dial only asks the kernel to choose a source address,
// so no packet leaves the host and no third party is contacted.
func outboundIP() string {
	c, err := net.Dial("udp4", "192.0.2.1:9")
	if err != nil {
		return ""
	}
	defer c.Close()
	if ua, ok := c.LocalAddr().(*net.UDPAddr); ok && ua.IP != nil && !ua.IP.IsUnspecified() {
		return ua.IP.String()
	}
	return ""
}
