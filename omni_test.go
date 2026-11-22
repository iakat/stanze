package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// omniDir writes one complete engine directory and returns it.
func omniDir(t *testing.T, bodies map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	full := map[string]string{
		omniModel:  "0123456789",
		omniTokens: "tok",
		omniAPI:    "//api",
		omniGlue:   "//glue",
		omniWasm:   "wasm",
	}
	for name, body := range bodies {
		full[name] = body
	}
	for name, body := range full {
		if body == "" {
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// Without a directory, or with a directory that does not hold the whole
// bundle, nothing is offered: a page that offered half of it would fail after
// the guest already downloaded 348 MB.
func TestOmniOffMeans404(t *testing.T) {
	for _, dir := range []string{"", t.TempDir()} {
		h := omniHandler(dir)
		for _, path := range []string{"/omni/models", "/omni/" + omniModel, "/omni/" + omniAPI, "/omni/nothing"} {
			rec := httptest.NewRecorder()
			h(rec, httptest.NewRequest(http.MethodGet, path, nil))
			if rec.Code != http.StatusNotFound {
				t.Fatalf("%q %s = %d, want 404", dir, path, rec.Code)
			}
		}
	}
	// Half a bundle is not an offer either.
	dir := omniDir(t, map[string]string{omniWasm: ""})
	h := omniHandler(dir)
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/omni/models", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("models without the wasm = %d, want 404", rec.Code)
	}
}

// The model is 348 MB, so a range request has to resume it, HEAD has to report
// the size before a byte moves, and a second visit has to be a 304.
func TestOmniServesRanges(t *testing.T) {
	dir := omniDir(t, nil)
	mod := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)
	for _, name := range omniNames {
		if err := os.Chtimes(filepath.Join(dir, name), mod, mod); err != nil {
			t.Fatal(err)
		}
	}
	h := omniHandler(dir)

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodHead, "/omni/"+omniModel, nil))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Length") != "10" {
		t.Fatalf("HEAD model = %d, length %q, want 200 and 10", rec.Code, rec.Header().Get("Content-Length"))
	}
	if rec.Header().Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("model type = %q", rec.Header().Get("Content-Type"))
	}
	if rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("model cache header = %q, want no-cache", rec.Header().Get("Cache-Control"))
	}

	req := httptest.NewRequest(http.MethodGet, "/omni/"+omniModel, nil)
	req.Header.Set("Range", "bytes=2-5")
	rec = httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusPartialContent || rec.Body.String() != "2345" {
		t.Fatalf("range = %d %q, want 206 2345", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Range"); got != "bytes 2-5/10" {
		t.Fatalf("content-range = %q", got)
	}

	req = httptest.NewRequest(http.MethodGet, "/omni/"+omniModel, nil)
	req.Header.Set("If-Modified-Since", mod.Format(http.TimeFormat))
	rec = httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
		t.Fatalf("revalidation = %d with %d bytes, want 304 and none", rec.Code, rec.Body.Len())
	}

	for path, want := range map[string]string{
		"/omni/" + omniTokens: "text/plain; charset=utf-8",
		"/omni/" + omniAPI:    "text/javascript; charset=utf-8",
		"/omni/" + omniWasm:   "application/wasm",
	} {
		rec = httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != want {
			t.Fatalf("%s = %d, type %q, want 200 and %q", path, rec.Code, rec.Header().Get("Content-Type"), want)
		}
	}

	for _, path := range []string{"/omni/", "/omni/../omni.go", "/omni/sherpa-onnx-wasm-main-vad-asr.data", "/omni/notes.txt"} {
		rec = httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s = %d, want 404", path, rec.Code)
		}
	}

	rec = httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/omni/"+omniModel, nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST = %d, want 405", rec.Code)
	}
}

// The list carries every file with its size and sha256, by name, and answers
// HEAD without a body, so the page can show the download and check what it
// cached before a byte of the wasm is read.
func TestOmniModelsList(t *testing.T) {
	dir := omniDir(t, nil)
	h := omniHandler(dir)

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/omni/models", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("models = %d, want 200", rec.Code)
	}
	var body struct {
		Files []omniFile `json:"files"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("models body: %v", err)
	}
	if len(body.Files) != len(omniNames) {
		t.Fatalf("models = %d entries, want %d", len(body.Files), len(omniNames))
	}
	for i, f := range body.Files {
		if i > 0 && body.Files[i-1].Name > f.Name {
			t.Fatalf("order %q then %q, want by name", body.Files[i-1].Name, f.Name)
		}
		if f.SHA256 == "" || f.Size == 0 {
			t.Fatalf("%s has size %d and hash %q", f.Name, f.Size, f.SHA256)
		}
	}
	model := body.Files[0]
	if model.Name != omniModel || model.Size != 10 {
		t.Fatalf("model entry = %+v", model)
	}
	sum := sha256.Sum256([]byte("0123456789"))
	if model.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("model hash = %s", model.SHA256)
	}

	rec = httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodHead, "/omni/models", nil))
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("HEAD models = %d with %d bytes, want 200 and none", rec.Code, rec.Body.Len())
	}
}

// The published glue carries a preload of the zipformer demo. The call goes
// and the function of the same name stays, and a bundle without the call is
// served byte for byte.
func TestOmniGluePreload(t *testing.T) {
	glue := `var a=1;async function loadPackage(metadata){return metadata}loadPackage({"files":[{"filename":"demo.onnx","start":0,"end":9}],"remote_package_size":9});var b=2;`
	dir := omniDir(t, map[string]string{omniGlue: glue})
	h := omniHandler(dir)
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/omni/"+omniGlue, nil))
	got := rec.Body.String()
	if rec.Code != http.StatusOK {
		t.Fatalf("glue = %d, want 200", rec.Code)
	}
	if strings.Contains(got, "loadPackage({") {
		t.Fatalf("the preload call is still there: %s", got)
	}
	if !strings.Contains(got, "function loadPackage(metadata)") || !strings.HasSuffix(got, "var b=2;") {
		t.Fatalf("the rewrite changed more than the call: %s", got)
	}

	// The list reports the bytes the page will get, not the file on disk.
	rec = httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/omni/models", nil))
	var body struct {
		Files []omniFile `json:"files"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, f := range body.Files {
		if f.Name == omniGlue && f.Size != int64(len(got)) {
			t.Fatalf("listed glue size %d, served %d", f.Size, len(got))
		}
	}

	plain := "// no preload here\n"
	if out := string(omniStripPreload([]byte(plain))); out != plain {
		t.Fatalf("a bundle without the call changed: %q", out)
	}
}
