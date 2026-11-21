# Queue

One line per work item. The top item is the most important.

## In work, not live yet

- The join button asks for the camera and the microphone, the call starts with both on, and the browser remembers the last choice on the next visit (katia 13:26).

## Open

- Add post-quantum end-to-end encryption for all media and metadata: audio, video, the text in the room, and the names (katia, top priority).
- Keep queued work items durable under load: many requests in one turn must not drop them (coderobe).
- Decide the policy for custom room names: a guessed name lets people drop in, and the point of random ids is that they cannot (coderobe).
- Decide if a bot or a text peer can take part in a room: today only browsers join one, so the voice bridge from the jitsi port has no place here yet (open question, not started).
- Add a camera and microphone picker: the join asks for the camera and the microphone but always takes the default devices.
- Add a sound switch: the four cues and the lost connection chime are always on, they can only be made quiet by hand.
- Extend the stats panel with jitter, packet loss and a short history graph; today it shows bitrates, round trip time and the path.
- Give the per peer volume a stable identity beyond the name: two guests with the same name share one stored setting.
