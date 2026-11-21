// Command pack turns the client files into one gzip compressed tar that the
// server embeds. The tar is written with no timestamps, no owner names and a
// sorted order, so the same files always give the same bytes and two builds of
// one commit match.
package main

import (
	"archive/tar"
	"compress/gzip"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
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
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(*src, filepath.FromSlash(name)))
		if err != nil {
			fail(err)
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

func fail(err error) {
	fmt.Fprintln(os.Stderr, "pack:", err)
	os.Exit(1)
}
