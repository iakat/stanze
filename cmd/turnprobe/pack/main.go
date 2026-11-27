// Command pack turns the client files into one gzip compressed tar that the
// server embeds. The tar is written with no timestamps, no owner names and a
// sorted order, so the same files always give the same bytes and two builds of
// one commit match.
package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
)

func main() {
	src := flag.String("src", "static", "directory of client files")
	out := flag.String("out", "packed/static.tgz", "output archive")
	flag.Parse()

	var names []string
	err := filepath.WalkDir(*src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(*src, p)
		if err != nil {
			return err
		}
		names = append(names, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		fail(err)
	}
	sort.Strings(names)
	if len(names) == 0 {
		fail(fmt.Errorf("no files under %s", *src))
	}
	// The page fetches these at run time and a missing one is a broken feature
	// only the browser notices, so the packer refuses to ship without them.
	for _, must := range []string{"fe.wasm", "fe.q8"} {
		p := filepath.Join(*src, filepath.FromSlash(must))
		st, err := os.Stat(p)
		if err != nil {
			fail(fmt.Errorf("%s is missing: build the filter first (build.sh or tools/fewasm/build.sh)", p))
		}
		if st.Size() == 0 {
			fail(fmt.Errorf("%s is empty: build the filter first (build.sh or tools/fewasm/build.sh)", p))
		}
	}

	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		fail(err)
	}
	f, err := os.Create(*out)
	if err != nil {
		fail(err)
	}
	defer f.Close()

	zw, err := gzip.NewWriterLevel(f, gzip.BestCompression)
	if err != nil {
		fail(err)
	}
	tw := tar.NewWriter(zw)
	// The bundle key is made here, from the bytes that ship: the client files
	// are hashed and index.html names the hash in its script and style query.
	// A deploy never needs a key commit, and a browser never keeps a bundle
	// from a build before it.
	key := assetKey(*src, names)
	fmt.Printf("key %s\n", key)
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(*src, filepath.FromSlash(name)))
		if err != nil {
			fail(err)
		}
		if name == "index.html" {
			data = keyIndex(data, key)
		}
		hdr := &tar.Header{
			Name:     path.Clean(name),
			Mode:     0o644,
			Size:     int64(len(data)),
			Typeflag: tar.TypeReg,
			Format:   tar.FormatPAX,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			fail(err)
		}
		if _, err := tw.Write(data); err != nil {
			fail(err)
		}
	}
	if err := tw.Close(); err != nil {
		fail(err)
	}
	if err := zw.Close(); err != nil {
		fail(err)
	}
	if err := f.Close(); err != nil {
		fail(err)
	}
	fmt.Printf("packed %d files into %s\n", len(names), *out)
}

// assetKey hashes the client files that a page loads, so the key changes with
// any of them and a cached page cannot outlive its bundle.
func assetKey(src string, names []string) string {
	h := sha256.New()
	for _, name := range names {
		if name == "index.html" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(src, filepath.FromSlash(name)))
		if err != nil {
			fail(err)
		}
		fmt.Fprintf(h, "%s\x00%d\x00", name, len(data))
		h.Write(data)
	}
	return hex.EncodeToString(h.Sum(nil))[:12]
}

var keyPat = regexp.MustCompile(`\?v=[0-9A-Za-z._-]+`)

// keyIndex writes the key into every versioned reference of the page.
func keyIndex(data []byte, key string) []byte {
	return keyPat.ReplaceAll(data, []byte("?v="+key))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "pack:", err)
	os.Exit(1)
}
