package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A route is one list shared with the map load, so a folder the client loads
// from is in it. The sound cues are the newest folder, and a guest's browser
// fetches them by name: without the route every cue is a 404 the console shows.
func TestSfxFolderIsRouted(t *testing.T) {
	cfg := &Config{MaxPeers: 8, MaxRooms: 4}
	h, err := buildHandler(cfg, newServer(cfg, newHub(cfg), slog.New(slog.NewTextHandler(io.Discard, nil))))
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/sfx/msg.ogg", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/sfx/msg.ogg = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "audio/ogg" {
		t.Fatalf("cue type = %q, want audio/ogg", got)
	}
	if rec.Body.Len() == 0 {
		t.Fatal("cue is empty")
	}

	// A name the folder does not hold is out of reach, and the map is the only
	// source: a path that walks to another folder is cleaned by the mux first,
	// so what matters is that the cleaned target is served only if listed.
	for _, path := range []string{"/sfx/nope.ogg", "/nope/ios.ogg", "/openmoji/nope.svg"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s = %d, want 404", path, rec.Code)
		}
	}
}

// The list names every static folder the page loads from, with no repeat: a
// repeat is a second registration on one pattern, which panics the mux.
func TestFolderNamesHasNoRepeat(t *testing.T) {
	seen := make(map[string]bool)
	for _, name := range append(folderNames(), "openmoji") {
		if seen[name] {
			t.Fatalf("folder %q is listed twice", name)
		}
		seen[name] = true
	}
}
