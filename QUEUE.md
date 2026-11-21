# Queue

One line per work item. New work goes to the bottom.

- Keep queued work items durable under load: many requests in one turn must not drop them (coderobe).
- Decide the policy for custom room names: a guessed name lets people drop in, and the point of random ids is that they cannot (coderobe).
- Port the voice bridge to the rooms server, or state that rooms have no bot participant: a stanze room carries browser peers only, so ocbot can not join one with audio (from the jitsi port).
- Funny sound effects for the room events: join, leave, mic on, mic off (katia).
- Show the own tile with a placeholder when the camera is refused, so the mirror preview and the own badge are always visible (seen in Chromium without a camera).
- Add host controls: mute or remove one peer from the room.
- Test TURN allocations over plain HTTP, not only through the TLS proxy.
- Add a camera and microphone picker.
