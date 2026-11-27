package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// The client ships as one gzip compressed tar, not as loose files: the page is
// 6.5 MB on disk and 1.7 MB packed, so the binary carries the packed copy and
// unpacks it in memory at start. cmd/pack writes the archive before the build,
// with no timestamps, so two builds of one commit give the same bytes.
//
//go:embed packed/static.tgz
var embeddedPack []byte

// The queue and the done list ship inside the binary as a fallback, so the
// two links in the page always lead somewhere. A docs directory on disk wins.
//
//go:embed QUEUE.md DONE.md
var embeddedDocs embed.FS

func main() {
	cfg, err := loadConfig(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(2)
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: cfg.logLevel()}))
	slog.SetDefault(log)

	switch {
	case cfg.turnWanted():
		if cfg.TurnIPAuto {
			log.Info("turn: no address given, using the outbound address", "ip", cfg.TurnPublicIP)
		}
		if cfg.TurnSecretAuto {
			log.Info("turn: no secret given, using a random one for this start")
		}
	case cfg.Turn && cfg.TurnPublicIP == "":
		log.Error("turn is on but no usable address was found: set -turn-public-ip or TURN_PUBLIC_IP")
		os.Exit(2)
	default:
		log.Warn("turn disabled: pass -turn or leave TURN unset to offer the relay fallback")
	}

	hub := newHub(cfg)
	srv := newServer(cfg, hub, log)
	// A warning when the room cap is reached names a count and a cap, never a
	// room, and only once a minute.
	hub.log = func(rooms, limit int) {
		log.Warn("room cap reached: new rooms refused until a room closes", "rooms", rooms, "limit", limit)
	}
	stopSweep := make(chan struct{})
	go hub.runSweeper(stopSweep)

	var turnSrv interface{ Close() error }
	if cfg.turnWanted() {
		t, err := startTURN(cfg, log)
		if err != nil {
			log.Error("turn start failed", "err", err)
			os.Exit(1)
		}
		turnSrv = t
	}

	handler, err := buildHandler(cfg, srv)
	if err != nil {
		log.Error("static assets", "err", err)
		os.Exit(1)
	}

	httpSrv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("http listening", "addr", cfg.Listen)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	select {
	case err := <-errCh:
		log.Error("http server", "err", err)
	case <-ctx.Done():
		log.Info("shutting down")
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	// A websocket is not closed by Shutdown: the handler goroutines are left
	// running until the process exits. Closing the live sockets hands each
	// page a close frame, so a tab notices the call is over instead of finding
	// a dead socket later.
	// The sweeper goes first: a sweep running beside closeAll iterates rooms
	// whose peers are already leaving.
	close(stopSweep)
	hub.waitSweeper()
	srv.closeAll()
	httpSrv.Shutdown(shutdownCtx)
	if turnSrv != nil {
		turnSrv.Close()
	}
}

// buildHandler wires the page, the socket, the two docs and the drawings. Everything else is a 404, so there
// is no path that could list, count or reveal rooms.
func buildHandler(cfg *Config, srv *server) (http.Handler, error) {
	assets, err := loadAssets(cfg.StaticDir)
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", srv.handleWS)

	files := make(map[string]*asset, len(assets))
	for name, body := range assets {
		files[name] = newAsset(name, body)
	}
	// The gzip copies are made in the background at start, so the first guest
	// does not wait for the wasm to compress. A request that comes first makes
	// the copy itself; each asset is compressed once and never under a shared
	// lock, so one slow file does not hold up the others.
	go func() {
		for _, a := range files {
			if a.gzTag != "" {
				a.gzip()
			}
		}
	}()
	serve := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				w.Header().Set("Allow", "GET, HEAD")
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			a, ok := files[name]
			if !ok {
				http.NotFound(w, r)
				return
			}
			// The copy is a copy, not a transform: the bytes a client gets are
			// the bytes of the file, so the sha256 of a download and the sha256
			// of the file agree. The page is 6.5 MB of source and 1.7 MB on the
			// wire, and the wasm alone loses 3.9 MB.
			body, tag, h := a.body, a.tag, w.Header()
			gz := a.gzTag != "" && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
			if a.gzTag != "" {
				h.Set("Vary", "Accept-Encoding")
			}
			if gz {
				body, tag = a.gzip(), a.gzTag
			}
			// The files are public code and carry nothing of a room, so the
			// browser may keep them; no-cache makes it ask first, and an
			// unchanged file is a 304 with no body. A new binary has new tags.
			if h.Get("Cache-Control") == "" {
				h.Set("Cache-Control", "no-cache")
			}
			h.Set("ETag", tag)
			if etagMatch(r.Header.Get("If-None-Match"), tag) {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			// A text file is for reading, not for saving: the build stamp is
			// opened by hand as often as it is fetched, and a default type of
			// octet-stream would turn that into a download.
			if strings.HasSuffix(name, ".txt") {
				h.Set("Content-Disposition", "inline")
			}
			h.Set("Content-Type", a.ctype)
			if gz {
				h.Set("Content-Encoding", "gzip")
			}
			h.Set("Content-Length", strconv.Itoa(len(body)))
			w.Write(body)
		}
	}
	selfHash := binaryHash()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// No SPA fallback: anything that is not the single page is a 404.
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		// The hash of the file on disk, so a guest compares it with a local
		// build. It is a claim by the running process, not a proof.
		if selfHash != "" {
			w.Header().Set("X-Binary-SHA256", selfHash)
		}
		// The page carries the room in the fragment, so a kept copy is a leak on
		// a shared machine and nothing a reload needs.
		w.Header().Set("Cache-Control", "no-store")
		serve("index.html")(w, r)
	})
	for _, name := range assetNames() {
		mux.Handle("/"+name, serve(name))
	}
	// The drawings of the short code, the landmarker, the art a mask wears and
	// the sound cues are their own folders. The map holds only the listed
	// names, so any other path under a folder is still a 404 and nothing comes
	// from outside another folder in the archive.
	routes := folderNames()
	if !slices.Contains(routes, "openmoji") {
		routes = append(routes, "openmoji")
	}
	for _, name := range routes {
		mux.HandleFunc("/"+name+"/", func(w http.ResponseWriter, r *http.Request) {
			serve(strings.TrimPrefix(r.URL.Path, "/"))(w, r)
		})
	}
	// The queue and the done list are plain files on disk, so an update is a
	// file write and needs no new binary.
	mux.HandleFunc("/QUEUE.md", docHandler(cfg.DocsDir, "QUEUE.md"))
	mux.HandleFunc("/DONE.md", docHandler(cfg.DocsDir, "DONE.md"))
	// Optional transcription files, served from disk only when an operator
	// provides them; otherwise 404.
	mux.HandleFunc("/vosk/", voskHandler(cfg.VoskDir))
	mux.HandleFunc("/omni/", omniHandler(cfg.OmniDir))

	// A local run is plain http and a local run is never behind the proxy, so
	// BehindProxy is the flag that says the public name is https.
	return securityHeaders(mux, srv.log, cfg.VoskDir != "" || cfg.OmniDir != "", cfg.BehindProxy), nil
}

// asset is one served client file with what a response needs, made once at
// start: the content type and the two entity tags. The gzip copy is made at
// most once, by whoever asks first.
type asset struct {
	body  []byte
	ctype string
	tag   string // entity tag of the plain bytes
	gzTag string // entity tag of the gzip copy; empty for a type that is not compressed

	gzOnce sync.Once
	gz     []byte
}

func newAsset(name string, body []byte) *asset {
	sum := sha256.Sum256(body)
	id := hex.EncodeToString(sum[:16])
	a := &asset{body: body, ctype: contentType(name), tag: `"` + id + `"`}
	if compressible(name) {
		a.gzTag = `"` + id + `-gzip"`
	}
	return a
}

func (a *asset) gzip() []byte {
	a.gzOnce.Do(func() {
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		zw.Write(a.body)
		zw.Close()
		a.gz = buf.Bytes()
	})
	return a.gz
}

func compressible(name string) bool {
	for _, ext := range [...]string{".wasm", ".js", ".mjs", ".css", ".html", ".svg", ".md"} {
		if strings.HasSuffix(name, ext) {
			return true
		}
	}
	return false
}

// etagMatch reports whether an If-None-Match value names the tag. A weak
// prefix is ignored, as the comparison for this header allows.
func etagMatch(header, tag string) bool {
	for _, t := range strings.Split(header, ",") {
		t = strings.TrimPrefix(strings.TrimSpace(t), "W/")
		if t == tag || t == "*" {
			return true
		}
	}
	return false
}

// binaryHash returns the sha256 of the executable that is running, or an empty
// string when the file cannot be read, as with a memfd or a deleted image.
// It is computed once, at start, so a later replacement on disk does not change
// the answer the process gives about itself.
func binaryHash() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	f, err := os.Open(exe)
	if err != nil {
		return ""
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

// docHandler serves one markdown file, from the docs directory when a copy is
// there, else from the copy embedded in the binary. The content is served as
// plain text so every browser shows it inline.
func docHandler(dir, name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if dir != "" {
			// A file on disk is a live edit and wins over the embedded copy.
			if body, err := os.ReadFile(filepath.Join(dir, name)); err == nil {
				w.Header().Set("Content-Type", "text/plain; charset=utf-8")
				w.Header().Set("Cache-Control", "no-store")
				w.Write(body)
				return
			}
		}
		body, err := fs.ReadFile(embeddedDocs, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(body)
	}
}

// loadAssets gives the client files as bytes: from the directory override when
// one is set, else from the embedded archive. The audio worklet bundle and the
// drawings are added last, so both paths end with the same map.
func loadAssets(dir string) (map[string][]byte, error) {
	out := make(map[string][]byte)
	if dir != "" {
		for _, name := range assetNames() {
			if name == workletBundle {
				continue
			}
			b, err := os.ReadFile(path.Join(dir, name))
			if err != nil {
				return nil, err
			}
			out[name] = b
		}
		if err := loadOpenmoji(dir, out); err != nil {
			return nil, err
		}
		for _, name := range folderNames() {
			if err := loadFolder(dir, name, out); err != nil {
				return nil, err
			}
		}
		return withWorkletBundle(out), nil
	}
	if err := unpackArchive(out); err != nil {
		return nil, err
	}
	for _, name := range assetNames() {
		if name == workletBundle {
			continue
		}
		if _, ok := out[name]; !ok {
			return nil, fmt.Errorf("client archive has no %s", name)
		}
	}
	return withWorkletBundle(out), nil
}

// unpackArchive fills out with every file of the embedded archive. The packed
// copy is the source of the served bytes, so a name in the archive that is not
// in assetNames() is still kept: the drawings are found by their prefix.
func unpackArchive(out map[string][]byte) error {
	zr, err := gzip.NewReader(bytes.NewReader(embeddedPack))
	if err != nil {
		return err
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		data := make([]byte, hdr.Size)
		if _, err := io.ReadFull(tr, data); err != nil {
			return err
		}
		out[path.Clean(hdr.Name)] = data
	}
}

// loadOpenmoji reads the drawings of the short code. One directory of small
// SVG files, so a glob is shorter than a second list that could drift from
// the client, and a missing drawing fails the build, not a call.
func loadOpenmoji(dir string, out map[string][]byte) error {
	// With the archive the drawings are already in out, found by their prefix.
	if dir == "" {
		return nil
	}
	names, err := filepath.Glob(filepath.Join(dir, "openmoji", "*.svg"))
	if err != nil {
		return err
	}
	for _, name := range names {
		b, err := os.ReadFile(name)
		if err != nil {
			return err
		}
		out["openmoji/"+filepath.Base(name)] = b
	}
	return nil
}

// loadFolder reads one static subdirectory into the asset map: the landmarker
// files, the drawings a mask wears, the world beside them. They are read by
// name from the one folder, and the folder may be absent: without the
// landmarker the client keeps its colour based face patch, without a drawing a
// mask falls back to its own vector, and without a map a room keeps its call
// grid, so an extra is never a reason to fail.
func loadFolder(dir, name string, out map[string][]byte) error {
	root := filepath.Join(dir, name)
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if entry.IsDir() {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		// The key is the path under static/ with forward slashes, which is the
		// name the page asks for: world/maps/office.json, never a native
		// separator and never a name outside the one folder.
		out[filepath.ToSlash(rel)] = b
		return nil
	})
}

// folderNames is every static subdirectory the client may load a file from:
// the landmarker, the drawing a mask wears, the sound cues and the world. The
// short code drawings are the fifth, read by a glob of their own.
func folderNames() []string {
	return []string{"facemesh", "miku", "sfx", "world"}
}

func assetNames() []string {
	return []string{
		"index.html", "app.js", "brand.js", "style.css", "favicon.svg",
		// The commit the page was built from, written by build.sh or the image.
		"version.txt",
		// The house typeface: Arial metrics, shipped with the page so every
		// browser puts the same letters on the same pixels.
		"lsans.woff2", "lsans-bold.woff2",
		"gtcrn.js", "gtcrn-worklet.js", "gtcrn.wasm", workletBundle,
		// The incoming stream filter: the wasm engine, its weights, and the
		// node and worker that run it.
		"fe.wasm", "fe.q8", "fe-NOTICE.txt",
		"fastenhancer-worklet.js", "fastenhancer-worker.js",
		// The sealed half of the one client: the frame worker, the off-thread
		// derivation of the room key, and the WebAssembly build of the key
		// agreement. The old e2e page is gone.
		"e2e-transform.js", "wasm-derive.js", "wasm_exec.js", "pq.wasm",
		// The cues are Opus for size; the mp3 stays as a fallback. The first
		// seven are the Jitsi Meet sounds, the rest are this page's own.
		"sfx/joined.webm", "sfx/joined.ogg", "sfx/joined.mp3",
		"sfx/left.webm", "sfx/left.ogg", "sfx/left.mp3",
		"sfx/knock.webm", "sfx/knock.ogg", "sfx/knock.mp3",
		"sfx/raisehand.webm", "sfx/raisehand.ogg", "sfx/raisehand.mp3",
		"sfx/msg.webm", "sfx/msg.ogg", "sfx/msg.mp3",
		"sfx/unmuted.webm", "sfx/unmuted.ogg", "sfx/unmuted.mp3",
		"sfx/muted.webm", "sfx/muted.ogg", "sfx/muted.mp3",
		"sfx/timp.webm", "sfx/hammer.webm", "sfx/lost.webm",
		"sfx/timp.ogg", "sfx/hammer.ogg", "sfx/lost.ogg",
		"sfx/timp.mp3", "sfx/hammer.mp3", "sfx/lost.mp3",
		"sfx-NOTICE.txt",
	}
}

// workletBundle is the one module the audio worklet loads. A worklet module
// has its own scope, so a second module can not share its globals: the wasm
// bundle and the processor must be served as a single file.
const workletBundle = "gtcrn-node.js"

// withWorkletBundle glues the module loader and the processor into the single
// module that /gtcrn-node.js serves. The loader defines `Module` in that same
// scope, so the processor can call it.
func withWorkletBundle(in map[string][]byte) map[string][]byte {
	// The loader looks for `self` in a worker scope, which a worklet still
	// treats as an alias of the global object; set it first.
	shim := []byte("var self = globalThis;\n")
	joined := make([]byte, 0, len(shim)+len(in["gtcrn.js"])+len(in["gtcrn-worklet.js"]))
	joined = append(joined, shim...)
	joined = append(joined, in["gtcrn.js"]...)
	joined = append(joined, in["gtcrn-worklet.js"]...)
	in[workletBundle] = joined
	return in
}

func contentType(name string) string {
	switch {
	case strings.HasSuffix(name, ".html"):
		return "text/html; charset=utf-8"
	case strings.HasSuffix(name, ".js"):
		return "text/javascript; charset=utf-8"
	case strings.HasSuffix(name, ".mjs"):
		return "text/javascript; charset=utf-8"
	case strings.HasSuffix(name, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(name, ".txt"):
		return "text/plain; charset=utf-8"
	case strings.HasSuffix(name, ".svg"):
		return "image/svg+xml"
	case strings.HasSuffix(name, ".woff2"):
		return "font/woff2"
	case strings.HasSuffix(name, ".wasm"):
		return "application/wasm"
	case strings.HasSuffix(name, ".mp3"):
		return "audio/mpeg"
	case strings.HasSuffix(name, ".webm"):
		return "audio/webm"
	case strings.HasSuffix(name, ".ogg"):
		return "audio/ogg"
	}
	return "application/octet-stream"
}

// cspPolicy is the policy of the page. It is one document and one policy: a
// worker inherits the policy of the document that starts it, so a per path
// header would not reach the transcription engines.
//
// Every source is 'self' or a blob of 'self'. There is no third party script,
// style, font, image, frame or connection: signaling is same origin /ws, and a
// socket to that host is what 'self' matches. A wide ws: or wss: source would
// let an injected line open a socket anywhere, so it is not there.
//
// 'wasm-unsafe-eval' is always on: the key agreement and the noise filter are
// wasm modules. 'unsafe-eval' is on only when an operator offers transcription,
// because the emscripten wrappers of both engines are made with new Function.
// A deployment without those directories gets no eval at all, and then
// Trusted Types, which stops a string from reaching a script sink. The two
// cannot hold together: eval itself is a Trusted Types sink.
func cspPolicy(asr, tlsOnly bool) string {
	script := "script-src 'self' 'wasm-unsafe-eval'"
	if asr {
		script += " 'unsafe-eval'"
	}
	policy := "default-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; " +
		script + "; script-src-attr 'none'; " +
		"worker-src 'self' blob:; style-src 'self'; style-src-attr 'none'; " +
		"img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; manifest-src 'self'; " +
		"connect-src 'self'; " +
		"frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
	if !asr {
		policy += "; require-trusted-types-for 'script'; trusted-types stanze"
	}
	// Behind a proxy the public name is https, and a plain http subresource is a
	// mistake to repair, not to load. A local run over http keeps it off, or the
	// browser would ask for https on a port that has no certificate.
	if tlsOnly {
		policy += "; upgrade-insecure-requests"
	}
	return policy
}

// securityHeaders keeps the client dependency-free and locked down. Room ids
// live only in the URL fragment, so no path or query ever carries them.
//
// The omnilingual engine is a pthread wasm build and allocates a
// SharedArrayBuffer, which a page only gets when it is cross-origin isolated:
// that is COOP same-origin plus COEP require-corp. Everything the page loads is
// its own origin or a blob of it (no third party script, font, image or frame),
// so require-corp costs nothing here; the browser suites still join, seal and
// play a call with it on. CORP same-origin names the rule on our own answers,
// so a resource of this page is not embedded elsewhere either.
func securityHeaders(next http.Handler, log *slog.Logger, asr, tlsOnly bool) http.Handler {
	csp := cspPolicy(asr, tlsOnly)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("X-Permitted-Cross-Domain-Policies", "none")
		h.Set("X-XSS-Protection", "0")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), "+
			"geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), "+
			"idle-detection=(), xr-spatial-tracking=(), midi=(), accelerometer=(), gyroscope=(), magnetometer=()")
		h.Set("Origin-Agent-Cluster", "?1")
		h.Set("X-Robots-Tag", "noindex, nofollow")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Embedder-Policy", "require-corp")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		// A local run is plain http: an HSTS header on it would pin a name to
		// https that the server cannot answer. Behind the https proxy the
		// public name is https, and the header belongs there.
		if tlsOnly {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}

		if log.Enabled(r.Context(), slog.LevelDebug) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: 200}
			next.ServeHTTP(rec, r)
			log.Debug("request", "method", r.Method, "path", r.URL.Path, "status", rec.status, "dur", time.Since(start).String())
			return
		}
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := s.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("hijack unsupported")
	}
	return h.Hijack()
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
