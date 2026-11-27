package main

import (
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	_ "image/png"
	"os"
	"path/filepath"

	"testing"
)

// A floor tile is copied whole onto the floor canvas, so a tile whose art has a
// transparent column at its edge leaves that column unpainted and the page
// background (#1d1d20) shows through as a dark bar between two floor tiles. The
// default map paints the beige marble tile on every row of its interior, and
// that art carried a transparent first and last column, so the whole inner room
// came up striped. The check reads the shipped art with the geometry the map
// declares and fails when any visible layer leaves a pixel of the map unpainted.

type tiledMap struct {
	Width      int            `json:"width"`
	Height     int            `json:"height"`
	TileWidth  int            `json:"tilewidth"`
	TileHeight int            `json:"tileheight"`
	Tilesets   []tiledTileset `json:"tilesets"`
	Layers     []tiledLayer   `json:"layers"`
}

type tiledTileset struct {
	FirstGID   int    `json:"firstgid"`
	Source     string `json:"source"`
	Image      string `json:"image"`
	TileWidth  int    `json:"tilewidth"`
	TileHeight int    `json:"tileheight"`
	Columns    int    `json:"columns"`
	Margin     int    `json:"margin"`
	Spacing    int    `json:"spacing"`
}

type tiledLayer struct {
	Name    string          `json:"name"`
	Type    string          `json:"type"`
	Visible *bool           `json:"visible"`
	Data    json.RawMessage `json:"data"`
	Layers  []tiledLayer    `json:"layers"`
}

// layerVisible is the map's own rule: a layer is drawn unless it says false.
func layerVisible(l tiledLayer) bool {
	return l.Visible == nil || *l.Visible
}

// layerGIDs reads one tile layer. Tiled saves a layer as a list of gids or as
// base64 of gzip, zlib or raw bytes; the shipped maps use the list form, and a
// form this reader does not know is skipped rather than failed.
func layerGIDs(t *testing.T, l tiledLayer) []int {
	t.Helper()
	var list []int
	if err := json.Unmarshal(l.Data, &list); err == nil {
		return list
	}
	var text string
	if err := json.Unmarshal(l.Data, &text); err != nil {
		t.Fatalf("layer %q: data is neither a list nor a string", l.Name)
	}
	raw, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		t.Fatalf("layer %q: base64: %v", l.Name, err)
	}
	out := make([]int, 0, len(raw)/4)
	for i := 0; i+3 < len(raw); i += 4 {
		out = append(out, int(uint32(raw[i])|uint32(raw[i+1])<<8|uint32(raw[i+2])<<16|uint32(raw[i+3])<<24))
	}
	return out
}

// walkTileLayers collects the drawn tile layers in map order, groups included.
func walkTileLayers(list []tiledLayer, out *[]tiledLayer) {
	for _, l := range list {
		switch l.Type {
		case "group":
			walkTileLayers(l.Layers, out)
		case "tilelayer":
			if layerVisible(l) {
				*out = append(*out, l)
			}
		}
	}
}

// tiledMapCase is one shipped map and the folder its tileset images live in.
type tiledMapCase struct {
	name    string
	mapPath string
	artDir  string
}

// openTileSet reads the tileset of one map entry, following an external .tsj to
// the file that holds the image and its geometry.
func openTileSet(t *testing.T, c tiledMapCase, ts tiledTileset) (tiledTileset, image.Image) {
	t.Helper()
	body := ts
	dir := c.artDir
	if ts.Source != "" {
		p := filepath.Join(c.artDir, ts.Source)
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		if err := json.Unmarshal(b, &body); err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		body.FirstGID = ts.FirstGID
		dir = filepath.Dir(p)
	}
	if body.Columns <= 0 {
		body.Columns = 1
	}
	if body.TileWidth == 0 {
		body.TileWidth = 32
	}
	if body.TileHeight == 0 {
		body.TileHeight = 32
	}
	// The image path is written relative to the file that declares it: beside
	// the map for an inline tileset, beside the .tsj for an external one.
	p := filepath.Join(dir, filepath.FromSlash(body.Image))
	f, err := os.Open(p)
	if err != nil {
		t.Fatalf("%s: %v", p, err)
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		t.Fatalf("%s: %v", p, err)
	}
	return body, img
}

// opaque reports whether a pixel paints anything. The floor canvas starts clear,
// so a pixel with a zero alpha is a pixel the page background shows through.
func opaque(c color.Color) bool {
	_, _, _, a := c.RGBA()
	return a != 0
}

// TestFloorArtCoversEveryPixel walks each shipped map with the tileset geometry
// the map declares and fails when a drawn tile leaves a pixel of the map
// unpainted. It is the check that was missing when the beige marble tile came
// up with a transparent rim: every cell of the default map was filled, so no
// test looked at the art, and the page drew a dark bar per tile.
func TestFloorArtCoversEveryPixel(t *testing.T) {
	cases := []tiledMapCase{
		{name: "default", mapPath: "static/world/map.json", artDir: "static/world"},
		{name: "office", mapPath: "static/world/maps/office.tmj", artDir: "static/world/maps"},
		{name: "conference", mapPath: "static/world/maps/conference.tmj", artDir: "static/world/maps"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			raw, err := os.ReadFile(c.mapPath)
			if err != nil {
				t.Fatalf("%s: %v", c.mapPath, err)
			}
			var m tiledMap
			if err := json.Unmarshal(raw, &m); err != nil {
				t.Fatalf("%s: %v", c.mapPath, err)
			}
			if m.TileWidth == 0 || m.TileHeight == 0 {
				t.Fatalf("%s: no tile size", c.mapPath)
			}
			width, height := m.Width, m.Height
			if width == 0 || height == 0 {
				t.Fatalf("%s: no map size", c.mapPath)
			}

			// The sheet of every tileset, read once.
			type sheet struct {
				set tiledTileset
				img image.Image
			}
			var sets []sheet
			for _, ts := range m.Tilesets {
				set, img := openTileSet(t, c, ts)
				sets = append(sets, sheet{set: set, img: img})
			}
			// The highest firstgid at or below a gid wins, as the client does.
			pick := func(gid int) *sheet {
				var hit *sheet
				for i := range sets {
					if gid >= sets[i].set.FirstGID && (hit == nil || sets[i].set.FirstGID > hit.set.FirstGID) {
						hit = &sets[i]
					}
				}
				return hit
			}

			// covered is one flag per map pixel, in the layout the canvas uses.
			pxW, pxH := width*m.TileWidth, height*m.TileHeight
			covered := make([]bool, pxW*pxH)
			var layers []tiledLayer
			walkTileLayers(m.Layers, &layers)
			for _, l := range layers {
				data := layerGIDs(t, l)
				if len(data) < width*height {
					t.Fatalf("layer %q holds %d cells, the map wants %d", l.Name, len(data), width*height)
				}
				for i := 0; i < width*height; i++ {
					gid := data[i] & 0x1fffffff
					if gid == 0 {
						continue
					}
					s := pick(gid)
					if s == nil {
						t.Fatalf("layer %q: gid %d names no tileset", l.Name, gid)
					}
					index := gid - s.set.FirstGID
					sx := s.set.Margin + (index%s.set.Columns)*(s.set.TileWidth+s.set.Spacing)
					sy := s.set.Margin + (index/s.set.Columns)*(s.set.TileHeight+s.set.Spacing)
					dx := (i % width) * m.TileWidth
					dy := (i / width) * m.TileHeight
					for y := 0; y < s.set.TileHeight; y++ {
						for x := 0; x < s.set.TileWidth; x++ {
							if opaque(s.img.At(sx+x, sy+y)) {
								covered[(dy+y)*pxW+dx+x] = true
							}
						}
					}
				}
			}

			// A hole is reported with the run it forms, so a failing case names
			// the bar a viewer sees and not just a pixel count.
			var firstX, firstY, holes = -1, -1, 0
			for y := 0; y < pxH; y++ {
				for x := 0; x < pxW; x++ {
					if covered[y*pxW+x] {
						continue
					}
					holes++
					if firstX < 0 {
						firstX, firstY = x, y
					}
				}
			}
			if holes == 0 {
				return
			}
			// The width of the bar that starts at the first hole, so a report
			// says one px or six, not a bare count.
			run := 0
			for firstX+run < pxW && !covered[firstY*pxW+firstX+run] {
				run++
			}
			t.Fatalf("%s: %d of %d map pixels are unpainted; the first bar is %d px wide at (%d,%d), which the page draws as #1d1d20",
				c.mapPath, holes, pxW*pxH, run, firstX, firstY)
		})
	}
}

// TestMarbleTileHasNoTransparentRim is the direct case for the art that showed
// the bars: the beige tile the default map repeats across the inner room must
// paint its own edge, because a floor tile is copied whole and nothing behind it
// is painted. The art is the one the page ships, read with the atlas geometry.
func TestMarbleTileHasNoTransparentRim(t *testing.T) {
	raw, err := os.ReadFile("static/world/atlas.json")
	if err != nil {
		t.Fatal(err)
	}
	var atlas struct {
		Image  string `json:"image"`
		Frames map[string]struct {
			X int `json:"x"`
			Y int `json:"y"`
			W int `json:"w"`
			H int `json:"h"`
		} `json:"frames"`
	}
	if err := json.Unmarshal(raw, &atlas); err != nil {
		t.Fatal(err)
	}
	f, ok := atlas.Frames["floor.marble"]
	if !ok {
		t.Fatal("atlas.json has no floor.marble frame")
	}
	file, err := os.Open(filepath.Join("static/world", atlas.Image))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	img, _, err := image.Decode(file)
	if err != nil {
		t.Fatal(err)
	}
	if !image.Pt(f.X+f.W, f.Y+f.H).In(img.Bounds()) {
		t.Fatalf("frame %d,%d %dx%d is outside %v", f.X, f.Y, f.W, f.H, img.Bounds())
	}
	// Every pixel of the frame paints, so no column of the cell can show the
	// background between two copies of the tile.
	var clear int
	for y := f.Y; y < f.Y+f.H; y++ {
		for x := f.X; x < f.X+f.W; x++ {
			if !opaque(img.At(x, y)) {
				clear++
			}
		}
	}
	if clear != 0 {
		t.Fatalf("floor.marble frame %d,%d %dx%d has %d transparent pixels; a floor copy shows each as #1d1d20",
			f.X, f.Y, f.W, f.H, clear)
	}
}
