# Queue

One line per work item. The top item is the most important.

## In work, not live yet

- Fix the centre name of a tile: turn the camera on and then off, and the name in the middle of the tile is gone (coderobe 16:42).
- Show the sealed code of a guest only while the pointer is over that tile (coderobe 16:42).
- Make the sealed code panel look better: it is one long clipped line today (coderobe 16:42).

## Open

- Decide the policy for custom room names: a guessed name lets people drop in, and the point of random ids is that they cannot (coderobe).
- Decide if a bot or a text peer can take part in a room: today only browsers join one, so the voice bridge from the jitsi port has no place here yet (open question, not started).
- Add a camera and microphone picker: the join asks for the camera and the microphone but always takes the default devices. Choose the device before the join and keep the choice beside the name. On Android and GrapheneOS the default microphone can be a device that gives silence, so this may be the same fault as the silent phone call (katia 14:33).
- Add a sound switch: the four cues and the lost connection chime are always on, they can only be made quiet by hand.
- Extend the stats panel with jitter, packet loss and a short history graph; today it shows bitrates, round trip time and the path.
- Give the per peer volume a stable identity beyond the name: two guests with the same name share one stored setting.
