package main

import (
	"net/http"
	"os"
	"path/filepath"
)

// The optional speech to text engine runs in the browser and is never part of
// this binary. An operator who wants it puts two files in one directory (see
// tools/fetch-vosk.sh) and starts the server with -vosk-dir. Without the
// directory both routes answer 404, the client sees that and says the server
// has no model, and nothing else changes. A guest's tab fetches the files only
// when the guest asks for transcription.
//
//	/vosk/vosk.js         the vosk-browser library (Apache-2.0)
//	/vosk/model.tar.gz    one small model, the only one this server offers
var voskFiles = map[string]string{
	"/vosk/vosk.js":      "text/javascript; charset=utf-8",
	"/vosk/model.tar.gz": "application/gzip",
}

// voskHandler serves the two files from dir. ServeContent answers HEAD with the
// size, so the page can show the download before it starts, and it honours
// If-Modified-Since, so a cached model is revalidated with a 304 and not
// fetched again.
func voskHandler(dir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		ctype, ok := voskFiles[r.URL.Path]
		if !ok || dir == "" {
			http.NotFound(w, r)
			return
		}
		f, err := os.Open(filepath.Join(dir, filepath.Base(r.URL.Path)))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil || st.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", ctype)
		// Keep it in the browser cache, but ask the server on every use.
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, "", st.ModTime(), f)
	}
}
