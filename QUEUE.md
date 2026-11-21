# Queue

One line per work item. New work goes to the bottom.

- Commit the `go.mod` 1.27 line together with the rest of the tree, after the in-flight work lands (coderobe).
- Keep queued work items durable under load: many requests in one turn must not drop them (coderobe).
- Decide the policy for custom room names: a guessed name lets people drop in, and the point of random ids is that they cannot (coderobe).
- Port the voice bridge to the rooms server, or state that rooms have no bot participant: a stanze room carries browser peers only, so ocbot can not join one with audio (from the jitsi port).
- Ship the rnnoise microphone filter on by default, with a switch that turns it off (katia).
- Choose P2P only or relay only before the join (katia).
- Screen sharing with audio, plus a choice of resolution and frame rate (katia).
- Funny sound effects for the room events: join, leave, mic on, mic off (katia).
- Remember the visitor name in the browser and prefill it on the next visit (coderobe; written in the tree, not deployed yet).
- Accept arbitrary room names and prefill a random 128 bit id for a private room (coderobe; written in the tree, not deployed yet).
- Mirror the own camera preview by default with a toggle, and keep remote tiles unmirrored (coderobe; written in the tree, not deployed yet).
- Deploy the current tree and test it in a browser; the live site is older than the tree (custom names, media path, screen share, quality, rnnoise, 1990s look, mirror).
- Give the client a 1990s software look (katia, confirmed GO 12:52).
- Add host controls: mute or remove one peer from the room.
- Test TURN allocations over plain HTTP, not only through the TLS proxy.
- Add a camera and microphone picker; the client joins watch-only when both are refused.
