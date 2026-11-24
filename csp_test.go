package main

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The policy has two shapes: with transcription an engine needs eval, without
// it the page can have Trusted Types. Both must stay closed in the same way:
// nothing inline, nothing third party, one origin for everything.
func TestCSPPolicy(t *testing.T) {
	strict := cspPolicy(false, true)
	eval := cspPolicy(true, false)

	for name, policy := range map[string]string{"strict": strict, "eval": eval} {
		for _, want := range []string{
			"default-src 'none'",
			"object-src 'none'",
			"frame-src 'none'",
			"script-src 'self' 'wasm-unsafe-eval'",
			"script-src-attr 'none'",
			"style-src-attr 'none'",
			"connect-src 'self'",
			"frame-ancestors 'none'",
			"base-uri 'none'",
			"form-action 'none'",
		} {
			if !strings.Contains(policy, want) {
				t.Errorf("%s policy misses %q", name, want)
			}
		}
		for _, forbidden := range []string{"'unsafe-inline'", "ws:", "wss:", "*"} {
			if strings.Contains(policy, forbidden) {
				t.Errorf("%s policy still has %q", name, forbidden)
			}
		}
	}

	if strings.Contains(strict, "'unsafe-eval'") {
		t.Error("strict policy carries eval")
	}
	if !strings.Contains(strict, "upgrade-insecure-requests") {
		t.Error("strict policy under a proxy does not upgrade http subresources")
	}
	if strings.Contains(eval, "upgrade-insecure-requests") {
		t.Error("a local http run must not upgrade its own subresources")
	}
	if !strings.Contains(strict, "require-trusted-types-for 'script'") || !strings.Contains(strict, "trusted-types stanze") {
		t.Error("strict policy does not enforce Trusted Types")
	}

	if !strings.Contains(eval, "'unsafe-eval'") {
		t.Error("eval policy misses the transcription exception")
	}
	if strings.Contains(eval, "trusted-types") {
		t.Error("eval policy names Trusted Types, which eval cannot satisfy")
	}
}

// The headers reach every answer, and the handler still serves the body.
func TestSecurityHeaders(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	rec := httptest.NewRecorder()
	securityHeaders(next, slog.New(slog.DiscardHandler), false, false).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusTeapot {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusTeapot)
	}
	h := rec.Header()
	for name, want := range map[string]string{
		"Content-Security-Policy":           cspPolicy(false, false),
		"X-Content-Type-Options":            "nosniff",
		"X-Frame-Options":                   "DENY",
		"X-Permitted-Cross-Domain-Policies": "none",
		"Referrer-Policy":                   "no-referrer",
		"Cross-Origin-Opener-Policy":        "same-origin",
		"Cross-Origin-Embedder-Policy":      "require-corp",
		"Cross-Origin-Resource-Policy":      "same-origin",
	} {
		if got := h.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
	if pp := h.Get("Permissions-Policy"); !strings.Contains(pp, "usb=()") || !strings.Contains(pp, "camera=(self)") {
		t.Errorf("Permissions-Policy = %q", pp)
	}
}
