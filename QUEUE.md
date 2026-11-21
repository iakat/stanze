# Queue

One line per work item. New work goes to the bottom.
The first group is built in the working tree and not live on
https://stanze.ch-test.katia.sh yet; each line moves to DONE.md after the
deploy is live and checked.

## In the build, waiting to ship

- Room text chat: a message box, a line list, the recent 100 lines handed to a late joiner, and join, leave, mute, kick and admin as events in the same list (coderobe, katia 12:53).
- Several admins per room at once: the first peer holds the role and the role passes to the oldest peer only when the room has none, with the list broadcast on every change.
- A kick marks the peer, so the room log shows the kick and not a second plain leave.
- Cartoon cues on join, leave, mic on and mic off, mono Opus from the Hanna-Barbera library with mp3 kept as a fallback (coderobe 13:08, 13:14).
- One cue at a time: a new cue replaces the one playing, every cue plays in full and none is cut (katia 13:15).
- A calm synthesized pad loops under the room while the signaling socket is down (katia 13:32): a new cue with no sample to credit, seamless, and it stops the moment the client is back.
- Per-peer volume slider 0 to 200 percent, unity at 100, kept per participant name.
- Stats panel behind a button: up and down kbit/s per peer and in total, with the live path and rate lines.

## Open

- Add post-quantum end-to-end encryption for all media and metadata: audio, video, the text in the room, and the names (katia, top priority).
- Keep queued work items durable under load: many requests in one turn must not drop them (coderobe).
- Port the voice bridge to the rooms server, or state that a room carries browser peers only (katia, open question).
- Jitsi room listing, as one concrete test (katia 13:37): connect to `wss://framatalk.org/xmpp-websocket`, send a `disco#items` query to `conference.framatalk.org`, and count the items. Measured: zero items and no error, so that host does not publish its rooms. The same probe goes against every jitsi host we compare with, and stanze keeps no listing route at all.
- Test TURN allocations over plain HTTP, not only through the TLS proxy.
- Add a camera and microphone picker.
