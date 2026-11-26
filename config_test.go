package main

import (
	"net"
	"strconv"
	"strings"
	"testing"
)

// No STUN URL and no third-party default: the relay is on out of the box, and
// it is the STUN endpoint, so a browser never talks to anyone but us.
func TestTurnOnByDefault(t *testing.T) {
	cfg, err := loadConfig([]string{})
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.turnEnabled() {
		t.Fatal("turn is off by default")
	}
	if !cfg.TurnSecretAuto || !cfg.TurnIPAuto {
		t.Fatalf("not auto: secret %v address %v", cfg.TurnSecretAuto, cfg.TurnIPAuto)
	}
	want := "stun:" + cfg.TurnPublicIP + ":" + strconv.Itoa(cfg.TurnPort)
	if len(cfg.StunURLs) != 1 || cfg.StunURLs[0] != want {
		t.Fatalf("stun urls = %v, want %s", cfg.StunURLs, want)
	}
	if strings.Contains(cfg.TurnSecret, "google") || len(cfg.TurnSecret) < 32 {
		t.Fatalf("bad generated secret %q", cfg.TurnSecret)
	}
	ice, err := iceServersFor(cfg, randomUserTag())
	if err != nil || len(ice) != 2 || ice[1].Username == "" {
		t.Fatalf("ice list = %v (%v)", ice, err)
	}
}

func TestTurnOff(t *testing.T) {
	cfg, err := loadConfig([]string{"-turn=false"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.turnEnabled() || len(cfg.StunURLs) != 0 {
		t.Fatalf("turn off but enabled=%v stun=%v", cfg.turnEnabled(), cfg.StunURLs)
	}
}

func TestTurnExplicitWins(t *testing.T) {
	cfg, err := loadConfig([]string{"-turn-secret", "s", "-turn-public-ip", "2001:db8::1", "-turn-port", "3479"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.TurnSecretAuto || cfg.TurnIPAuto {
		t.Fatal("explicit values marked as auto")
	}
	if len(cfg.StunURLs) != 1 || cfg.StunURLs[0] != "stun:[2001:db8::1]:3479" {
		t.Fatalf("stun urls = %v", cfg.StunURLs)
	}
}

// A port of 0 asks for a free one. Binding first and writing the port back
// keeps one source of truth: the joined frame then names the socket the relay
// listens on, never :0, which a browser refuses as an ICE server.
func TestTurnPortZeroTakesBoundPort(t *testing.T) {
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := boundPort(conn)
	conn.Close()
	if port <= 0 {
		t.Fatal("the bound socket named no port")
	}

	cfg, err := loadConfig([]string{"-turn-secret", "s", "-turn-public-ip", "203.0.113.7", "-turn-port", "0"})
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.StunURLs) != 0 {
		t.Fatalf("stun urls before the bind = %v, want none", cfg.StunURLs)
	}

	setTurnPort(cfg, port)

	want := "stun:203.0.113.7:" + strconv.Itoa(port)
	if len(cfg.StunURLs) != 1 || cfg.StunURLs[0] != want {
		t.Fatalf("stun urls = %v, want %s", cfg.StunURLs, want)
	}
	ice, err := iceServersFor(cfg, randomUserTag())
	if err != nil {
		t.Fatal(err)
	}
	var urls []string
	for _, s := range ice {
		urls = append(urls, s.URLs...)
	}
	if len(urls) != 2 {
		t.Fatalf("ice urls = %v", urls)
	}
	for _, u := range urls {
		if strings.HasSuffix(u, ":0") || strings.Contains(u, ":0?") {
			t.Fatalf("ice url names no port: %s", u)
		}
	}
	if ice[1].URLs[0] != "turn:203.0.113.7:"+strconv.Itoa(port)+"?transport=udp" {
		t.Fatalf("turn urls = %v", ice[1].URLs)
	}
}

// The port is only known once the socket is bound. Until then the list holds
// nothing the browser would reject, and an explicit STUN list is left alone.
func TestTurnPortUnbound(t *testing.T) {
	cfg, err := loadConfig([]string{"-turn-secret", "s", "-turn-public-ip", "203.0.113.7", "-turn-port", "0"})
	if err != nil {
		t.Fatal(err)
	}
	ice, err := iceServersFor(cfg, randomUserTag())
	if err != nil {
		t.Fatal(err)
	}
	if len(ice) != 0 {
		t.Fatalf("ice list before the bind = %v, want none", ice)
	}

	cfg, err = loadConfig([]string{"-turn-secret", "s", "-turn-public-ip", "203.0.113.7", "-turn-port", "0", "-stun", "stun:stun.example:3478"})
	if err != nil {
		t.Fatal(err)
	}
	setTurnPort(cfg, 49000)
	if len(cfg.StunURLs) != 1 || cfg.StunURLs[0] != "stun:stun.example:3478" {
		t.Fatalf("explicit stun replaced: %v", cfg.StunURLs)
	}
}

// With the relay off there is no port to advertise, so no embedded URL either.
func TestTurnDisabledNoICE(t *testing.T) {
	cfg, err := loadConfig([]string{"-turn=false", "-turn-port", "0"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.turnEnabled() {
		t.Fatal("turn enabled with the relay off")
	}
	ice, err := iceServersFor(cfg, randomUserTag())
	if err != nil || len(ice) != 0 {
		t.Fatalf("ice list = %v (%v), want none", ice, err)
	}
	if len(cfg.StunURLs) != 0 {
		t.Fatalf("stun urls = %v, want none", cfg.StunURLs)
	}
}
