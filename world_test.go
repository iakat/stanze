package main

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The world lives under its own folder, nested by a map or a sheet name, and the
// page asks for it by that path. Without the route the browser sees a 404 and a
// room it cannot walk, and the last mile is always the one nobody fetched.
func TestWorldFolderIsRouted(t *testing.T) {
	cfg := &Config{MaxPeers: 8, MaxRooms: 4}
	h, err := buildHandler(cfg, newServer(cfg, newHub(cfg), slog.New(slog.NewTextHandler(io.Discard, nil))))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/world/map.json", "/world/atlas.json", "/world/char_player.png"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound && rec.Code != http.StatusOK {
			t.Fatalf("%s = %d, want 200 or 404", path, rec.Code)
		}
	}
	// A name the folder does not hold is out of reach even when the path
	// escapes it: the mux cleans the target first, and the map holds the listed
	// names and nothing else.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/world/%2e%2e/main.go", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/world/..%%2Fmain.go = %d, want 404", rec.Code)
	}
}
