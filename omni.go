package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// The multilingual engine is the second optional speech to text engine that
// runs in the tab, next to vosk. It is one model for every language (1600 of
// them), so there is no picker and no per language file: the directory holds
// the sherpa-onnx wasm bundle and that one model.
//
//	/omni/models                            the files, sizes and sha256, as JSON
//	/omni/model.int8.onnx                   the Omnilingual ASR CTC 300M int8 export
//	/omni/tokens.txt                        the token table
//	/omni/sherpa-onnx-asr.js                the OfflineRecognizer API layer
//	/omni/sherpa-onnx-wasm-main-vad-asr.js  the emscripten glue, preload removed
//	/omni/sherpa-onnx-wasm-main-vad-asr.wasm
//
// Without -omni-dir the whole prefix is a 404 and the page does not offer the
// engine. The model is streamed from the disk on every request and never kept
// in the process, because it is 348 MB and the pod has 256 Mi; only the
// rewritten glue and the small hash table are held.
const (
	omniModel  = "model.int8.onnx"
	omniTokens = "tokens.txt"
	omniAPI    = "sherpa-onnx-asr.js"
	omniGlue   = "sherpa-onnx-wasm-main-vad-asr.js"
	omniWasm   = "sherpa-onnx-wasm-main-vad-asr.wasm"
)

// omniNames is the whole namespace. A name that is not here is never opened,
// so nothing else on the disk is reachable, whatever its name.
var omniNames = []string{omniModel, omniTokens, omniAPI, omniGlue, omniWasm}

// omniFile is one entry of the list the page reads before it downloads.
type omniFile struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
	SHA256   string `json:"sha256"`
}

func omniServes(path string) (string, bool) {
	base := strings.TrimPrefix(path, "/omni/")
	for _, name := range omniNames {
		if base == name {
			return name, true
		}
	}
	return "", false
}

// omniList names the files the directory holds. The engine is offered only
// when all of them are there: half a bundle is not a smaller offer, it is a
// page that fails after the guest already paid for the download.
func omniList(dir string) []omniFile {
	if dir == "" {
		return nil
	}
	out := make([]omniFile, 0, len(omniNames))
	for _, name := range omniNames {
		path := filepath.Join(dir, name)
		st, err := os.Stat(path)
		if err != nil || !st.Mode().IsRegular() {
			return nil
		}
		entry := omniFile{Name: name, Size: st.Size(), Modified: st.ModTime().Unix()}
		if name == omniGlue {
			// The glue is served rewritten, so the size and the hash the page
			// reads are the ones of the bytes it will get.
			body, err := omniGlueBody(path, st)
			if err != nil {
				return nil
			}
			entry.Size, entry.SHA256 = int64(len(body)), omniHash(body)
		}
		out = append(out, entry)
	}
	for i := range out {
		if out[i].SHA256 != "" {
			continue
		}
		sum, err := omniSum(dir, out[i].Name, out[i].Size, out[i].Modified)
		if err != nil {
			return nil
		}
		out[i].SHA256 = sum
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func omniHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// The hash of the 348 MB model is made once per size and modification time,
// streamed with a small buffer: the pod has 256 Mi of memory and reading the
// model into it would end the process. The page checks the hash of what it
// cached, so a truncated or stale entry is caught before the wasm reads it.
var (
	omniSumMu   sync.Mutex
	omniSumSeen = make(map[string]string)
)

func omniSum(dir, name string, size, modified int64) (string, error) {
	key := name + ":" + strconv.FormatInt(size, 10) + ":" + strconv.FormatInt(modified, 10)
	omniSumMu.Lock()
	if sum, ok := omniSumSeen[key]; ok {
		omniSumMu.Unlock()
		return sum, nil
	}
	omniSumMu.Unlock()
	f, err := os.Open(filepath.Join(dir, name))
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	sum := hex.EncodeToString(h.Sum(nil))
	omniSumMu.Lock()
	omniSumSeen[key] = sum
	omniSumMu.Unlock()
	return sum, nil
}

// omniStripPreload removes the demo model preload from the emscripten glue.
// The published bundle carries a loadPackage({...}) call that fetches about
// 190 MB of the zipformer demo, which this page never uses: the Omnilingual
// model comes from OPFS and goes into the wasm filesystem with
// FS_createDataFile. The call becomes the expression 0, the function of the
// same name above it stays, and the result is served in its place, so the file
// on the disk can stay the pristine one from the tarball.
func omniStripPreload(body []byte) []byte {
	const call = "loadPackage("
	var out []byte
	last, from := 0, 0
	for {
		rel := bytes.Index(body[from:], []byte(call))
		if rel < 0 {
			break
		}
		i := from + rel
		from = i + len(call)
		if bytes.HasSuffix(bytes.TrimSpace(body[max(0, i-32):i]), []byte("function")) {
			continue
		}
		// The argument is skipped by counting brackets, with strings skipped so
		// that a bracket inside a name cannot end the call early.
		depth, quote := 0, byte(0)
		j := i + len(call) - 1
		for ; j < len(body); j++ {
			c := body[j]
			if quote != 0 {
				if c == '\\' {
					j++
				} else if c == quote {
					quote = 0
				}
				continue
			}
			switch c {
			case '\'', '"', '`':
				quote = c
			case '(', '[', '{':
				depth++
			case ')', ']', '}':
				depth--
			}
			if depth == 0 && c == ')' {
				break
			}
		}
		if j >= len(body) {
			return body
		}
		out = append(out, body[last:i]...)
		out = append(out, '0')
		last, from = j+1, j+1
	}
	if last == 0 {
		return body
	}
	return append(out, body[last:]...)
}

// The glue is 114 KB and the rewrite reads it whole; one copy is kept per file
// version, the same way the vosk library keeps its gzip copy.
var (
	omniGlueMu  sync.Mutex
	omniGlueKey string
	omniGlueRaw []byte
)

func omniGlueBody(path string, st os.FileInfo) ([]byte, error) {
	key := strconv.FormatInt(st.Size(), 10) + "-" + strconv.FormatInt(st.ModTime().UnixNano(), 10)
	omniGlueMu.Lock()
	defer omniGlueMu.Unlock()
	if omniGlueRaw != nil && omniGlueKey == key {
		return omniGlueRaw, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	omniGlueKey, omniGlueRaw = key, omniStripPreload(raw)
	return omniGlueRaw, nil
}

// omniHandler serves the model, the token table and the engine from dir.
// ServeContent does the work: the model is 348 MB and a range request has to
// resume it, HEAD has to report the size before a byte moves, and
// If-Modified-Since has to turn a second visit into a 304.
func omniHandler(dir string) http.HandlerFunc {
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
		if r.URL.Path == "/omni/models" {
			list := omniList(dir)
			if len(list) == 0 {
				http.NotFound(w, r)
				return
			}
			body, err := json.Marshal(struct {
				Files []omniFile `json:"files"`
			}{list})
			if err != nil {
				http.Error(w, "could not read the files", http.StatusInternalServerError)
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
		name, ok := omniServes(r.URL.Path)
		if !ok {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(dir, name)
		f, err := os.Open(path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil || !st.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		switch name {
		case omniAPI, omniGlue:
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		case omniWasm:
			w.Header().Set("Content-Type", "application/wasm")
		case omniTokens:
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		default:
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		// Keep it in the browser cache, but ask the server on every use.
		w.Header().Set("Cache-Control", "no-cache")
		if name == omniGlue {
			if body, err := omniGlueBody(path, st); err == nil {
				http.ServeContent(w, r, "", st.ModTime(), bytes.NewReader(body))
				return
			}
		}
		http.ServeContent(w, r, "", st.ModTime(), f)
	}
}
