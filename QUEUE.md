# Queue

One line per work item. New work goes to the bottom.

- Commit the `go.mod` 1.27 line together with the rest of the tree, after the in-flight work lands (coderobe).
- Keep queued work items durable under load: many requests in one turn must not drop them (coderobe).
- Decide the policy for custom room names: a guessed name lets people drop in, and the point of random ids is that they cannot (coderobe).
- Port the voice bridge to the rooms server, or state that rooms have no bot participant: a stanze room carries browser peers only, so ocbot can not join one with audio (from the jitsi port).
- Ship the rnnoise microphone filter on by default, with a switch that turns it off (katia).
- Choose P2P only or relay only before the join (katia).
- Screen sharing with audio, plus a choice of resolution and frame rate (katia).
- Give the client a 1990s software look; katia said noooo just after the ask, so confirm first (katia).
- Add host controls: mute or remove one peer from the room.
- Test TURN allocations over plain HTTP, not only through the TLS proxy.
- Add a camera and microphone picker; the client joins watch-only when both are refused.
