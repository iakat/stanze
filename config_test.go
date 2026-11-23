package main

import "testing"

// No STUN URL and no third-party default: the embedded relay is the STUN
// endpoint, so a browser never talks to anyone but us.
func TestStunDefaultsToEmbeddedTurn(t *testing.T) {
	cfg, err := loadConfig([]string{"-turn-public-ip", "203.0.113.7", "-turn-secret", "s"})
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.StunURLs) != 1 || cfg.StunURLs[0] != "stun:203.0.113.7:3478" {
		t.Fatalf("stun urls = %v", cfg.StunURLs)
	}
	cfg, err = loadConfig([]string{"-turn-public-ip", "2001:db8::1", "-turn-secret", "s", "-turn-port", "3479"})
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.StunURLs) != 1 || cfg.StunURLs[0] != "stun:[2001:db8::1]:3479" {
		t.Fatalf("stun urls = %v", cfg.StunURLs)
	}
}
