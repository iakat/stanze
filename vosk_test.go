package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Without a directory the routes do not exist: nothing is offered and nothing
// leaks about the disk. The old single name is gone too, so it is a 404 like
// any other name the list does not hold.
func TestVoskOffMeans404(t *testing.T) {
	h := voskHandler("")
	for _, path := range []string{"/vosk/vosk.js", "/vosk/model.tar.gz", "/vosk/models", "/vosk/model-it.tar.gz", "/vosk/other"} {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s without a directory = %d, want 404", path, rec.Code)
		}
	}
}

// Only the library and the model files are served, HEAD reports the size so the
// page can show the download before it starts, and a file the list does not
// name is out of reach.
func TestVoskServesTheListedFilesOnly(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("model-en.tar.gz", "0123456789")
	write("model-it.tar.gz", "01234")
	write("vosk.js", "//lib")
	write("secret.txt", "no")

	h := voskHandler(dir)

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodHead, "/vosk/model-it.tar.gz", nil))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Length") != "5" {
		t.Fatalf("HEAD model-it = %d, length %q, want 200 and 5", rec.Code, rec.Header().Get("Content-Length"))
	}
	if rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("model cache header = %q, want no-cache", rec.Header().Get("Cache-Control"))
	}
	if rec.Header().Get("Content-Type") != "application/gzip" {
		t.Fatalf("model type = %q, want application/gzip", rec.Header().Get("Content-Type"))
	}

	rec = httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/vosk/vosk.js", nil))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "text/javascript; charset=utf-8" {
		t.Fatalf("vosk.js = %d, type %q, want 200 and javascript", rec.Code, rec.Header().Get("Content-Type"))
	}

	for _, path := range []string{"/vosk/secret.txt", "/vosk/../secret.txt", "/vosk/", "/vosk/model-fr.tar.gz"} {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s = %d, want 404", path, rec.Code)
		}
	}

	rec = httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/vosk/model-en.tar.gz", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST = %d, want 405", rec.Code)
	}
}

// The list names every model with its label and its size, by label, and it
// answers HEAD without a body.
func TestVoskModelsList(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"model-it.tar.gz": "01234",
		"model-en.tar.gz": "0123456789",
		"vosk.js":         "//lib",
		"notes.txt":       "no",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h := voskHandler(dir)

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/vosk/models", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("models = %d, want 200", rec.Code)
	}
	var body struct {
		Langs []voskModel `json:"langs"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("models body: %v", err)
	}
	if len(body.Langs) != 2 {
		t.Fatalf("models = %d entries, want 2", len(body.Langs))
	}
	if body.Langs[0].Lang != "en" || body.Langs[1].Lang != "it" {
		t.Fatalf("order = %q then %q, want en then it", body.Langs[0].Lang, body.Langs[1].Lang)
	}
	if body.Langs[0].Size != 10 || body.Langs[1].Size != 5 {
		t.Fatalf("sizes = %d and %d, want 10 and 5", body.Langs[0].Size, body.Langs[1].Size)
	}

	rec = httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodHead, "/vosk/models", nil))
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("HEAD models = %d with %d bytes, want 200 and none", rec.Code, rec.Body.Len())
	}
}

// A label that is not a short one is not a model, so a curious name on the disk
// stays off the list.
func TestVoskModelNamePattern(t *testing.T) {
	for name, want := range map[string]bool{
		"model-en.tar.gz":        true,
		"model-it.tar.gz":        true,
		"model-pt-br.tar.gz":     true,
		"model-e.tar.gz":         false,
		"model-EN.tar.gz":        false,
		"model-en.tar.gz.bak":    false,
		"model-.tar.gz":          false,
		"model-en.zip":           false,
		"xmodel-en.tar.gz":       false,
		"model-en.tar.gz/../x.y": false,
	} {
		got := voskModelName.MatchString(name)
		if got != want {
			t.Fatalf("%q matches = %v, want %v", name, got, want)
		}
	}
}
