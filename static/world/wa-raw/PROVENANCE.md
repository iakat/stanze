# Provenance: WorkAdventure source assets

All files under `wa-raw/` are unmodified byte-for-byte copies fetched over HTTP
(GitHub REST API tree list + `raw.githubusercontent.com`), no git clone. Each
local file was re-verified against upstream with SHA-256 at the pinned commit
below on 2026-11-26; every hash matched.

- Repository: `github.com/workadventure/workadventure`
- Pinned commit: `5762aeebd729fe021b34afd565d1d346534f7393`
  (`master`, 2026-11-26T20:53:19Z, "fix(tilemap): draw first-column tiles
  correctly on GPU tile layers")
- Raw URL base: `https://raw.githubusercontent.com/workadventure/workadventure/5762aeebd729fe021b34afd565d1d346534f7393/`
- Local path = repo path relative to that base; spaces in names URL-encoded
  on fetch, restored locally.

## Upstream licence note

The repository is licensed **AGPLv3 plus Commons Clause**
(`play/LICENSE.txt`, `desktop/LICENSE.txt`; GitHub reports `license: null`).
Several art files carry their own third-party notices which override that.
See `researchB_assets.md` for the full review. Katia has ruled this project an
academic study, so upstream licences are recorded here for traceability rather
than treated as a redistribution blocker; the published set under
`static/world/` is a redraw, not the copied sheets.

## Files (repo path, bytes, sha256)

| Repo path | Bytes | sha256 | Upstream / licence |
|---|---|---|---|
| maps/Tuto/Attribution-tilesets.txt | 431 | c638926b234ace0d0667a11ce9d70d57a89a05afbfae42dd111adad56aa03e04 | licence text: tileset1 = CC-BY-SA 3.0 OR GPL 3.0 |
| maps/assets/tileset1.png | 29402 | 2eacd8e2d8491305d406c125825934f43daa6817f087a31f40de0d6759ec2140 | LPC-derived, CC-BY-SA 3.0 / GPL 3.0 |
| maps/assets/tileset1-repositioning.png | 24854 | 4b5a0568224cc3e40b2eeb907b57465f7683d243af9206caa69a26f15eb1f5d1 | same as tileset1 |
| maps/assets/tileset5_export.png | 23277 | ce630402ad41c9009847215a06348a6db5f1a34a8290a81778e9bc95afc81c91 | no notice; assume AGPL+CC |
| maps/assets/tileset6_export.png | 23306 | 0aaf68a047535dfb3b4bc556d9db0b3dadead3592adb2ecd87e0b3498b55a772 | no notice; assume AGPL+CC |
| maps/assets/Special_Zones.png | 10918 | 82160dc5638dcba69f665760dbae1d83ead2af8bdd768aa4f65ae5da3133e423 | no notice; assume AGPL+CC |
| maps/assets/skins/skin-blue.png | 12676 | 8ba401f203f8a011d9f5237b5eb6989007df18b579351571e229d1359a7d4335 | no notice; grid matches LPC walkcycle |
| maps/assets/skins/skin-green.png | 13572 | 552d2b343453437a12b446dcab770583eead59eb4d1c06eca0ba12d4b230ed36 | same |
| maps/assets/skins/skin-yellow.png | 14003 | 1e35852370d7167a0fdd77527199626fe99ab5d4ebee2e151653e7f750d775bb | same |
| maps/starter/map.json | 33251 | 9b26f1167e3d66af0e606388633ff127665bf03c659056c44dfdd0bdb7fa1859 | WorkAdventure-original, AGPL+CC |
| play/public/resources/tilesets/floor_tiles.png | 19880 | c4f85e61e64284f3fe49aa36c91efe9074cb4f855feb7a4a9d24f17577f11564 | no notice; assume AGPL+CC |
| play/public/resources/characters/pipoya/about.txt | 149 | eb1e2b6f3aca0caa8556b93372b696f9f90dd0c4fd0ce2c1f522ce71e83a72bf | pointer to Pipoya Itch page |
| play/public/resources/characters/pipoya/Cat 01-1.png | 1425 | 74d314de4f3d19e62147b4a2ef1b6d5289621880bcf94629f5b907d5e8725a11 | Pipoya Free RPG Character Sprites 32x32 (author licence: use/edit freely, no asset resale) |
| play/public/resources/characters/pipoya/Female 01-1.png | 3060 | 35b2c3598d65e16c4835f45fca3ff12f0865d1393202a8469004924bdc4b758a | same |
| play/public/resources/characters/pipoya/Female 01-2.png | 3082 | 514f830ed4306791652db379f78eb1633865486aca145dd1144c3f9e2a4d4601 | same |
| play/public/resources/characters/pipoya/Male 01-1.png | 3488 | 359c9cac3e90d706e00dd4f123d43e449c2f2c7871ff3e1ec9d1544cb9ad8e3d | same |
| play/public/resources/characters/pipoya/Male 01-2.png | 3501 | 8cf44a305292706843984185ce1c65ab90ae5158be8917b3bf829eb8a111bfdf | same |
| play/src/front/Phaser/Player/Animation.ts | 1994 | 722fb5d6dd1e8539f87b2adfc9ee3d8d2fbcfd3b6638030e5ab3ae11bfad2d47 | code, read only to confirm frame order (down/left/right/up = rows 0-3) |
| play/src/front/Stores/EmoteStore.ts | 2696 | 78e5253a2573e2e288793277682f1ec5acec1904e3cddd620c9ef9179eda5af8 | code, Unicode emoji list |

## Derived (published) files under `static/world/`

These are the minimal set shipped to the game; they are redraws / crops, not
the raw sheets:

- `atlas.png` (265x199, 8x6 grid of 32x32 tiles, 1px margin+spacing) — redraw
  of office floor/wall/object tiles, 41 named tiles, see `atlas.json`.
- `atlas.json` — Aseprite/Tiled-style frame map for `atlas.png`.
- `char_player.png` (128x128, 4x4 grid of 32x32 cells: 4 directions x 3 walk
  frames + 1 idle) — crop of `pipoya/Female 01-1.png` (96x128, 3x4), rows
  relaid N/E/S/W and padded with an idle column. Pipoya author licence applies.
- `map.json` — Tiled 1.10 orthogonal map, 24x16 tiles of 32px, hand-written
  (not copied from `starter/map.json`).
