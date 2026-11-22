package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// The optional speech to text engine runs in the browser and is never part of
// this binary. An operator who wants it puts the library and one or more models
// in one directory (see tools/fetch-vosk.sh) and starts the server with
// -vosk-dir. Without the directory every route answers 404, the client sees
// that and says the server has no model, and nothing else changes. A guest's
// tab fetches a model only when the guest asks for transcription.
//
//	/vosk/vosk.js              the vosk-browser library (Apache-2.0)
//	/vosk/models               the models the directory holds, as JSON
//	/vosk/model-<lang>.tar.gz  one model per language, <lang> like en or it
//
// One name, one shape: a model is always model-<lang>.tar.gz. The label is for
// the picker, not a claim about the model: the operator names the file, the
// guest picks the label. English is not a special file, it is the label en.
const voskLib = "vosk.js"

// voskModelName matches one model file and captures its label.
var voskModelName = regexp.MustCompile(`^model-([a-z]{2,3}(?:-[a-z0-9]{2,7})?)\.tar\.gz$`)

// voskModel is one entry of the list the page reads.
type voskModel struct {
	Lang     string `json:"lang"`
	File     string `json:"file"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
}

// voskModels reads the directory and returns the models it holds, by label, so
// the picker has a stable order. A missing directory and a failed read are both
// empty, because the page then offers nothing.
func voskModels(dir string) []voskModel {
	if dir == "" {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := make([]voskModel, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		m := voskModelName.FindStringSubmatch(name)
		if m == nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, voskModel{Lang: m[1], File: name, Size: info.Size(), Modified: info.ModTime().Unix()})
	}
	// One order for everybody: by label, so en comes first for free and no
	// language needs a rule of its own.
	sort.SliceStable(out, func(i, j int) bool { return out[i].Lang < out[j].Lang })
	return out
}

// voskServes reports whether one path under /vosk/ may be served. Only the
// library and a model name of the one accepted shape are served, so nothing
// else on the disk is reachable, and a name with a separator or a dot dot never
// matches. A name that passes but is not on disk is rejected by the open below.
func voskServes(path string) bool {
	base := strings.TrimPrefix(path, "/vosk/")
	if base == "" || base != filepath.Base(base) || strings.Contains(base, "..") {
		return false
	}
	return base == voskLib || voskModelName.MatchString(base)
}

// The library is 5.8 MB of script with the wasm inside, and it is the same
// bytes on every visit, so it is sent gzip: 2.3 MB on the wire. The copy is
// made once per file version and kept; a model is already gzip and is streamed
// from disk untouched.
var (
	voskJSMu   sync.Mutex
	voskJSKey  string
	voskJSBody []byte
)

func voskJSGzip(path string, st os.FileInfo) ([]byte, error) {
	key := strconv.FormatInt(st.Size(), 10) + "-" + strconv.FormatInt(st.ModTime().UnixNano(), 10)
	voskJSMu.Lock()
	defer voskJSMu.Unlock()
	if voskJSBody != nil && voskJSKey == key {
		return voskJSBody, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	_, _ = zw.Write(raw)
	_ = zw.Close()
	voskJSKey, voskJSBody = key, buf.Bytes()
	return voskJSBody, nil
}

// voskHandler serves the library, the model list and the model files from dir.
// ServeContent answers HEAD with the size, so the page can show the download
// before it starts, and it honours If-Modified-Since, so a cached file is
// revalidated with a 304 and not fetched again.
func voskHandler(dir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if dir == "" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == "/vosk/models" {
			list := voskModels(dir)
			if len(list) == 0 {
				http.NotFound(w, r)
				return
			}
			body, err := json.Marshal(struct {
				Langs []voskModel `json:"langs"`
			}{list})
			if err != nil {
				http.Error(w, "could not read the models", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			w.WriteHeader(http.StatusOK)
			if r.Method == http.MethodGet {
				_, _ = w.Write(body)
			}
			return
		}
		if !voskServes(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		name := filepath.Base(r.URL.Path)
		path := filepath.Join(dir, name)
		f, err := os.Open(path)
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
		if name == voskLib {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		} else {
			w.Header().Set("Content-Type", "application/gzip")
		}
		// Keep it in the browser cache, but ask the server on every use.
		w.Header().Set("Cache-Control", "no-cache")
		if name == voskLib {
			w.Header().Set("Vary", "Accept-Encoding")
			// A GET that accepts gzip gets the small copy. HEAD and a client
			// without gzip get the file itself, so the size in a HEAD answer is
			// always the size of the file on disk.
			if r.Method == http.MethodGet && st.Size() >= 1024 &&
				strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
				if body, err := voskJSGzip(path, st); err == nil {
					w.Header().Set("Content-Encoding", "gzip")
					http.ServeContent(w, r, "", st.ModTime(), bytes.NewReader(body))
					return
				}
			}
		}
		http.ServeContent(w, r, "", st.ModTime(), f)
	}
}
