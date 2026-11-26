# World assets: geometry and schema

Published minimal 2D office asset set for the stanze world. Sources of every
pixel are recorded in `wa-raw/PROVENANCE.md`. Total under 3 MB (see bottom).

## Files

| File | Bytes | What |
|---|---|---|
| `atlas.png` | ~3.8 KB | tileset atlas (all tiles) |
| `atlas.json` | ~3.1 KB | frame map for `atlas.png` |
| `char_player.png` | ~3.1 KB | character walk sheet |
| `map.json` | ~4.3 KB | Tiled 1.10 starter map |
| `wa-raw/` | — | unmodified originals, `PROVENANCE.md` inside |

## Tile geometry

- Tile size: **32 x 32 px**, square.
- Atlas sheet `atlas.png`: **265 x 199 px**, packed as an **8 x 6** grid of
  tiles with **1 px margin and 1 px spacing** (i.e. cell pitch 33 px; a tile at
  grid column `c`, row `r` sits at `x = 1 + c*33`, `y = 1 + r*33`). Image is
  4-channel RGBA (colour type 6), 8 bits.

## Character sheet `char_player.png`

- Sheet: **128 x 128 px**, single character.
- Cell: **32 x 32 px**, **4 columns x 4 rows**.
- Rows = facing (top to bottom): **N, E, S, W**.
- Columns = animation frames (left to right): **walk frame 0, walk frame 1,
  walk frame 2, idle**.
- Frame order within a row: `walk = [0, 1, 2, 1]` (ping-pong), loop rate
  ~10 fps; `idle` = the column-3 cell only.
- Pixel origin of cell (col `c`, row `r`): `x = c*32`, `y = r*32`.

## Map `map.json`

- Tiled version `1.11.0` (format version 1.10), orientation `orthogonal`,
  render order `right-down`, not infinite.
- Grid: **24 x 16** tiles of **32 x 32 px** (world size 768 x 512 px).
- Tileset reference: `atlas.png`, `firstgid: 1`, `columns: 8`,
  `tilecount: 41`, `margin: 1`, `spacing: 1`, tile 32x32.

### Layers (name -> purpose)
| Layer name | Type | Notes |
|---|---|---|
| `floor` | tilelayer | ground / carpet tiles |
| `walls` | tilelayer | wall + furniture drawn above floor |
| `objects` | tilelayer | decorative objects above walls |
| `spawn` | objectgroup | one point object named `spawn`; player start |
| `zones` | objectgroup | two rectangle objects, one per zone |

### Zone object properties
Each object in the `zones` layer is a `class`/`type` **`zone`** rectangle with a
`properties` array:

| Property | Type | Meaning |
|---|---|---|
| `kind` | string | zone kind: `meeting` or `silent` |
| `label` | string | display name, e.g. `Meeting room` |
| `color` | color | overlay colour, e.g. `#2f6f9f` |
| `proximity` | int | proximity radius in px (0 = no proximity chat) |
| `maxUsers` | int | occupancy cap |

Objects present:
- `meeting-room`: x=192, y=96, w=256, h=160, kind=`meeting`, proximity=192, maxUsers=8
- `silent-room`: x=448, y=288, w=192, h=128, kind=`silent`, proximity=0, maxUsers=4

## `atlas.json` schema

```jsonc
{
  "image":   "atlas.png",   // atlas file name
  "imageW":  265,           // atlas width px
  "imageH":  199,           // atlas height px
  "tile":    { "w": 32, "h": 32 },
  "gutter":  1,             // margin + spacing (px)
  "frames": {               // tile name -> pixel rect in atlas.png
    "<name>": { "x": 1, "y": 1, "w": 32, "h": 32 },
    ...
  }
}
```

Tile names are `<group>.<name>`, group being `floor`, `wall` or `obj`
(41 entries). Look a tile up by name, then slice the rect out of `atlas.png`.

## Size proof

```
du -ch atlas.png atlas.json char_player.png map.json   -> ~20 KB published set
du -sh static/world                                     -> ~360 KB incl. wa-raw originals
```
Both well under the 3 MB budget.
