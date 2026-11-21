# Queue

One line per work item. New work goes to the bottom.

- Commit the `go.mod` 1.27 line together with the rest of the tree, after the in-flight work lands (coderobe).
- Keep queued work items durable under load: many requests in one turn must not drop them (coderobe).
- Finish and verify the custom room names and the client-side rnnoise microphone filter that are in the tree now (separate session).
- Decide the fate of a room whose passphrase is lost: an emptied room is forgotten after 2 minutes and the next join creates it with a new passphrase.
- Decide the policy for custom room names: a guessed name lets people drop in, and the point of random ids is that they cannot (coderobe).
- Port the voice bridge to the rooms server, or state that rooms have no bot participant: a stanze room carries browser peers only, so ocbot can not join one with audio (from the jitsi port).
- Add host controls: mute or remove one peer from the room.
- Add a screen share track next to camera and microphone.
- Test TURN allocations over plain HTTP, not only through the TLS proxy.
- Add a camera and microphone picker; the client joins watch-only when both are refused.
