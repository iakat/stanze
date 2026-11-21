package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed static
var embeddedFS embed.FS

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

	if cfg.turnEnabled() && (cfg.TurnSecret == "" || cfg.TurnPublicIP == "") {
		log.Error("turn needs both public ip and shared secret")
		os.Exit(2)
	}
	if !cfg.turnEnabled() {
		log.Warn("turn disabled: set TURN_PUBLIC_IP and TURN_SECRET to offer a relay fallback")
	}

	hub := newHub(cfg)
	srv := newServer(cfg, hub, log)

	var turnSrv interface{ Close() error }
	if cfg.turnEnabled() {
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

	stop := make(chan struct{})
	go hub.runReaper(stop)
	go func() {
		t := time.NewTicker(10 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				srv.creates.prune()
				srv.joins.prune()
			}
		}
	}()

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

	close(stop)
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	httpSrv.Shutdown(shutdownCtx)
	if turnSrv != nil {
		turnSrv.Close()
	}
}

// buildHandler wires exactly four routes. Everything else is a 404, so there
// is no path that could list, count or reveal rooms.
func buildHandler(cfg *Config, srv *server) (http.Handler, error) {
	assets, err := loadAssets(cfg.StaticDir)
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/new", srv.handleNew)
	mux.HandleFunc("/ws", srv.handleWS)

	var wasmGz []byte
	var wasmOnce sync.Once
	serve := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				w.Header().Set("Allow", "GET, HEAD")
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			body, ok := assets[name]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", contentType(name))
			w.Header().Set("Cache-Control", "no-store")
			if name == "pq.wasm" && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
				// The WebAssembly build is 5 MiB; one gzip pass makes it 1.5 MiB.
				wasmOnce.Do(func() {
					var buf bytes.Buffer
					zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
					zw.Write(assets["pq.wasm"])
					zw.Close()
					wasmGz = buf.Bytes()
				})
				w.Header().Set("Content-Encoding", "gzip")
				w.Header().Set("Vary", "Accept-Encoding")
				w.Write(wasmGz)
				return
			}
			w.Write(body)
		}
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// No SPA fallback: anything that is not the single page is a 404.
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		serve("index.html")(w, r)
	})
	for _, name := range routeNames() {
		mux.Handle("/"+name, serve(name))
	}
	// The old sealed page is gone: its links land on the one join form with the
	// sealed toggle on. The redirect keeps no fragment of its own, so a link
	// like /e2e#r=<room> keeps its room and gains the flag.
	mux.HandleFunc("/e2e", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/?sealed=1", http.StatusFound)
	})
	// The queue and the done list are plain files on disk, so an update is a
	// file write and needs no new binary.
	mux.HandleFunc("/QUEUE.md", docHandler(cfg.DocsDir, "QUEUE.md"))
	mux.HandleFunc("/DONE.md", docHandler(cfg.DocsDir, "DONE.md"))

	return securityHeaders(mux, srv.log), nil
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

// loadAssets reads the embedded client, or a directory override for hacking on
// the frontend.
func loadAssets(dir string) (map[string][]byte, error) {
	if dir != "" {
		out := make(map[string][]byte)
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
		return withWorkletBundle(out), nil
	}
	out := make(map[string][]byte)
	for _, name := range assetNames() {
		if name == workletBundle {
			continue
		}
		b, err := fs.ReadFile(embeddedFS, "static/"+name)
		if err != nil {
			return nil, err
		}
		out[name] = b
	}
	return withWorkletBundle(out), nil
}

func assetNames() []string {
	return []string{
		"index.html", "app.js", "style.css", "favicon.svg",
		"rnnoise-sync.js", "rnnoise-worklet.js", workletBundle,
		// The sealed half of the one client: the frame worker and the
		// WebAssembly build of the key agreement. The old e2e page is gone.
		"e2e-transform.js", "wasm_exec.js", "pq.wasm",
		// The four cues are Opus for size; the mp3 stays as a fallback.
		"sfx/pop.webm", "sfx/bonk.webm", "sfx/timp.webm", "sfx/hammer.webm",
		"sfx/pop.ogg", "sfx/bonk.ogg", "sfx/timp.ogg", "sfx/hammer.ogg",
		"sfx/pop.mp3", "sfx/bonk.mp3", "sfx/timp.mp3", "sfx/hammer.mp3",
		// The lost connection pad is a loop, encoded the same way.
		"sfx/lost.webm", "sfx/lost.ogg", "sfx/lost.mp3",
	}
}

// workletBundle is the one module the audio worklet loads. A worklet module
// has its own scope, so a second module can not share its globals: the wasm
// bundle and the processor must be served as a single file.
const workletBundle = "rnnoise-node.js"

// routeNames is every served asset, sources and the combined worklet.
func routeNames() []string {
	return assetNames()
}

// withWorkletBundle glues the wasm bundle and the processor into the single
// module that /rnnoise-node.js serves.
func withWorkletBundle(in map[string][]byte) map[string][]byte {
	// The wasm bundle ends with `self.createRNNWasmModuleSync = ...`, but a
	// worklet module scope does not define `self` here, so alias it first.
	shim := []byte("var self = globalThis;\n")
	joined := make([]byte, 0, len(shim)+len(in["rnnoise-sync.js"])+len(in["rnnoise-worklet.js"]))
	joined = append(joined, shim...)
	joined = append(joined, in["rnnoise-sync.js"]...)
	joined = append(joined, in["rnnoise-worklet.js"]...)
	in[workletBundle] = joined
	return in
}

func contentType(name string) string {
	switch {
	case strings.HasSuffix(name, ".html"):
		return "text/html; charset=utf-8"
	case strings.HasSuffix(name, ".js"):
		return "text/javascript; charset=utf-8"
	case strings.HasSuffix(name, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(name, ".svg"):
		return "image/svg+xml"
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

// securityHeaders keeps the client dependency-free and locked down. Room ids
// live only in the URL fragment, so no path or query ever carries them.
func securityHeaders(next http.Handler, log *slog.Logger) http.Handler {
	const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; " +
		"media-src 'self' blob:; connect-src 'self' ws: wss:; font-src 'none'; " +
		"frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=(), interest-cohort=()")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Strict-Transport-Security", "max-age=31536000")

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
