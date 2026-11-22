package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Without a directory the routes do not exist: nothing is offered and nothing
// leaks about the disk.
func TestVoskOffMeans404(t *testing.T) {
	h := voskHandler("")
	for _, path := range []string{"/vosk/vosk.js", "/vosk/model.tar.gz", "/vosk/other"} {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s without a directory = %d, want 404", path, rec.Code)
		}
	}
}

// Only the two listed names are served, and HEAD reports the size so the page
// can show the download before it starts.
func TestVoskServesTheTwoFilesOnly(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "model.tar.gz"), []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("no"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := voskHandler(dir)

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodHead, "/vosk/model.tar.gz", nil))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Length") != "10" {
		t.Fatalf("HEAD model = %d, length %q, want 200 and 10", rec.Code, rec.Header().Get("Content-Length"))
	}
	if rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("model cache header = %q, want no-cache", rec.Header().Get("Cache-Control"))
	}

	for _, path := range []string{"/vosk/secret.txt", "/vosk/../secret.txt", "/vosk/vosk.js"} {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s = %d, want 404", path, rec.Code)
		}
	}

	rec = httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/vosk/model.tar.gz", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST = %d, want 405", rec.Code)
	}
}
