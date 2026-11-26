# Minigame host: the contract between the office world and what sits inside it

Status: design note, no code yet. Names here are the vocabulary the client files
(`world.ts`, `zones.ts`, `proximity.ts`, `positions.ts`, `introspect.ts`, `minigames/`) must share.
Nothing in this contract adds a server message: the Go server stays blind, and a minigame travels the same
sealed paths chat does.

## 1. What a minigame is

A minigame is **client code plus data**, hosted in a rectangle of the 2D world:

* its **screen**: the instance is "plugged into" one of the existing stage tiles (the thumbs the stage already
  shows), so the world only knows *which tile* and *what it shows*;
* its **field**: the shared state every player near the tile sees, `{k, ver, payload}` where `k` is the game id;
* its **input**: per-player, from the player's own keys or pointer, never from another player's client;
* its **score**, which is not its own: the world already keeps a per-player points balance (`introspection`),
  a minigame can only *propose* a delta on it (see §6).

A minigame never owns a timer that runs when nobody is in range, never opens a socket, never writes the DOM
outside its own node, and never calls `sealedSend` (the strict counter, see `WA_PORT_NOTES.md` §7b). Everything
it needs arrives through the port described in §3.

## 2. Lifecycle states

```
registered -> dormant -> open -> playing -> scored -> closed
                   ^        |         |                    |
                   +--------+---------+--------------------+   (back to dormant)
```

| state | who drives it | what exists |
|-------|---------------|-------------|
| `registered` | catalog load | a descriptor: id, tile, kind, maxPlayers, tickHz |
| `dormant` | nobody near | the tile shows an attract frame; no timer, no frames |
| `open` | first player enters the field zone | the host asks for `hello` + `sync` from the lowest peer id |
| `playing` | players inside the field zone | `input` at the game's own tick rate, `state` broadcast |
| `scored` | the game calls `score()` | one `points` proposal per participant, ordered by `ver` |
| `closed` | last player leaves, or an admin `close()` | final `state` with `ver`, then nothing |

Transitions are **local and deterministic**: every page runs the same state machine from the same `state`
frames and the same rule "lowest peer id is the writer", so no coordinator page exists to die.

## 3. The port (`MinigamePort`)

The host hands each instance one object. It is the only way out.

```ts
type MinigamePort = {
  // identity of this instance
  id: string;                 // catalog id, [a-z0-9-]{1,32}
  tile: string;               // stage tile label this instance is plugged into
  self: () => string;         // our peer id (hex 12)
  peers: () => { id: string; name: string; bot: boolean }[];  // inside the field, sorted

  // shared state, last writer wins on (ver, writer id)
  read: () => unknown;
  write: (payload: unknown) => void;       // -1.5 kB

  // private to this page
  onInput: (fn: (me: string, mask: number, at: number) => void) => void;   // mask = declared keys, bit order
  onState: (fn: (state: { ver: number; by: string; payload: unknown }) => void) => void;
  onJoin: (fn: (id: string) => void) => void;
  onLeave: (fn: (id: string) => void) => void;

  // presentation
  draw: (frame: { w: number; h: number; at: number }) => void;  // its own canvas only
  say: (text: string) => void;             // goes out as a chat line from the player

  // the outside
  score: (delta: number, why: string) => void;   // proposal, see §6
  close: () => void;                             // admin only, honoured by every page
};
```

Rules:

* `write` is accepted only from a peer the page believes is the current writer; every page applies the same
  check, so a modified client can only desync itself.
* `draw` is called from the world's single `requestAnimationFrame` loop with `at` = `performance.now()`, and only
  while the instance is `playing`. The instance gets no rAF of its own: at 6 avatars a second loop is 6 extra
  wake-ups per page.
* `onInput` carries the **movement keys** of this page only, as a bitmask, and the host rate-limits them to the
  game's `tickHz` (see §4). To know *which* keys a minigame reads, every game declares `keys: ['KeyW','Space']`
  in the catalog (§7). A key outside its declaration never becomes a direction in the world while the game is
  `playing`, so playing a minigame never makes the avatar walk away.
* Every call from an instance is wrapped and *rate-limited* on the host side; an instance that exceeds its
  budget is put back to `closed` and kept in a `failed` list for the dev screen.

## 4. Frames on the wire

One JSON frame kind on the `files` channel, next to `pos` (`positions.ts`) and `file` (`files.ts`):

```jsonc
{ "t": "mg", "id": "chess", "tile": "thumbs-3", "a": "write", "ver": 41, "w": "6f3a..", "p": {...} }
{ "t": "mg", "id": "chess", "a": "input", "at": 1699999999999, "m": 5 }   // m = key bitmask
{ "t": "mg", "id": "chess", "tile": "thumbs-3", "a": "sync",  "to": "6f3a.." }   // request, answered with write
```

* `a ∈ { write, input, sync }`; `input` is player private and is **not** broadcast.
* Sizes: `input` ≈ 60 B, `write` capped at **1536 B** JSON. Anything bigger is refused by the host and reported
  to the instance, not silently dropped.
* Rate: `input` at the game's `tickHz` (default **15 Hz**, ceiling **30**), `write` at most **10 Hz** per writer.
  Over-rate frames are dropped by the receiver, which is harmless: `write` is idempotent by `ver`.
* No new `enc` kind, no new DataChannel, no new socket verb. The relay never sees a byte: `mg` frames ride the
  direct P2P channel that already carries files.

## 5. Proximity

A minigame is **heard and seen by the bubble rule, not by its own rule**:

* players inside the tile's **field zone** (a `zone` with `kind: "stage"`, see `zones.ts`) join the instance;
* players inside the bubble are always in the field zone if the field zone encloses the bubble radius; the host
  enforces that at load and refuses a map where a `stage` zone is narrower than `2 * BUBBLE_R` (192 px);
* the instance sees `peers()` as the intersection "in field zone **and** in bubble", so a passer-by never becomes
  an opponent for 300 ms and never drags a seated player into a score.

## 6. Score, and why it is a proposal

The world's `introspection` keeps the only points balance (`state.points` per peer, already used for the coin
tally). A minigame may call `score(delta, why)`, which becomes:

```jsonc
{ "t": "mg", "a": "score", "id": "chess", "w": "6f3a..", "n": 7, "v": +1, "why": "checkmate" }
```

* the **writer** of the instance is the only page whose proposal counts; it sends one per `ver` of the final
  state, so a disputed game is not paid twice;
* a receiver applies a proposal only if it has seen the final state at that `ver` or higher, and only if
  `|v| <= 5` and `why` is in the game's declared list;
* `v` is an integer; the balance clamps at `>= 0`.

A modified client can propose a false win and honest pages accept it, exactly as it can walk through a wall. The
honest answer is the same as everywhere else in the mesh: the log is visible, the operator kicks.

## 7. The catalog

`static/office/minigames.json`, loaded once per tab:

```jsonc
{
  "games": [
    { "id": "chess", "tile": "thumbs-3", "tickHz": 2,  "maxPlayers": 2,
      "keys": ["KeyW","KeyA","KeyS","KeyD","Space"], "why": ["checkmate","resign"] },
    { "id": "snake", "tile": "thumbs-1", "tickHz": 15, "maxPlayers": 1,
      "keys": ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"], "why": ["apple"] },
    { "id": "pong",  "tile": "thumbs-2", "tickHz": 30, "maxPlayers": 2,
      "keys": ["KeyW","KeyS","ArrowUp","ArrowDown"], "why": ["point"] }
  ]
}
```

* `id` is `[a-z0-9-]{1,32}`; `tile` must exist in the map's stage layer; `tickHz` ≤ 30; `maxPlayers` ≥ 1;
  `keys` at most 16 entries of `KeyboardEvent.code`; `why` at most 8 entries of `[a-z ]{1,24}`.
* The catalog is the only place a game's key set is written, and the world reads it to decide whether a key
  moves the avatar or the game (see §3).
* The map never names a game. A map names tiles; the catalog says which tile has which game. Swapping a game for
  an office does not touch the map.
* A tile with no catalog entry is a plain screen (the existing share/thumbnail behaviour).

## 8. What the introspector needs from the office

The minigames are also the *observable surface* of the office, so `introspect.ts` must answer for each peer id:

```ts
type PeerView = {
  id: string; name: string; bot: boolean;
  x: number; y: number;              // integer map pixels
  dir: 0 | 1 | 2 | 3;                // UP RIGHT DOWN LEFT, WA order
  moving: boolean;
  zones: string[];                   // authored zone ids, not the bubble
  bubble: string[];                  // peer ids in the bubble, self excluded
  tile: string | null;               // stage tile being used, if any
  game: string | null;               // minigame id on that tile
};
```

and, per page: `points`, `framesOut`, `positionsSent`, `positionsRecv`, `mgWrites`, `mgInputs`,
`sealedAppSent`, `relayBytes` (all monotonic counters, reset by `reset()`).

The introspector may read this view and may call `say()`; it may not write `mg` frames, propose a score, or
draw. That keeps an observer from becoming a second authority.

## 9. Non-goals

No server-side minigame state, no matchmaking, no rooms inside rooms, no persistence of a game between visits,
no audio from a minigame (it would fight the voice path), no minigame that outlives its tile's occupancy.
