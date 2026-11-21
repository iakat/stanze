# Queue

One line per work item. New work goes to the bottom.

- Add post-quantum end-to-end encryption for all media and metadata: audio, video, the text in the room, and the names (katia, top priority).
- Keep queued work items durable under load: many requests in one turn must not drop them (coderobe).
- Decide the policy for custom room names: a guessed name lets people drop in, and the point of random ids is that they cannot (coderobe).
- Decide if a bot or a text peer can take part in a room: today only browsers join one, so the voice bridge from the jitsi port has no place here yet (open question, not started).
- Add host controls: mute or remove one peer from the room.
- Test TURN allocations over plain HTTP, not only through the TLS proxy.
- Add a camera and microphone picker.
