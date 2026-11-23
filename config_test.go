package main

import (
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
	ice, err := iceServersFor(cfg)
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
