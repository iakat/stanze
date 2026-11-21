# Queue

One line per work item. The top item is the most important.

## In work, not live yet


## Open

- Fix the sealed badge in a room with three or more guests: the code is derived per pair, so every pair has its own code and the badge says `pq-e2e codes differ` although the call is correct. The badge must show the code of one peer, or say that a mesh has one code per pair, and the alarm must stay per pair (coderobe 17:19).
- Decide the policy for custom room names: a guessed name lets people drop in, and the point of random ids is that they cannot (coderobe).
- Decide if a bot or a text peer can take part in a room: today only browsers join one, so the voice bridge from the jitsi port has no place here yet (open question, not started).
- Add a camera and microphone picker: the join asks for the camera and the microphone but always takes the default devices. Choose the device before the join and keep the choice beside the name. On Android and GrapheneOS the default microphone can be a device that gives silence, so this may be the same fault as the silent phone call (katia 14:33).
- Add a sound switch: the four cues and the lost connection chime are always on, they can only be made quiet by hand.
- Extend the stats panel with jitter, packet loss and a short history graph; today it shows bitrates, round trip time and the path.
- Give the per peer volume a stable identity beyond the name: two guests with the same name share one stored setting.
- Client side mesh transcription: one volunteer peer runs ASR on the incoming streams inside the page and sends the text as sealed chat, with a label that says who transcribed. Model: vosk small is 68 MB and is the cheap default; moonshine base is 274 MB and was asked for in the channel, so its size needs a pass before it ships (channel 17:22).
