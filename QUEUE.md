# Queue

One line per work item. The top item is the most important.

## In work, not live yet


## Open

- Fix the sealed badge in a room with three or more guests: the code is derived per pair, so every pair has its own code and the badge says `pq-e2e codes differ` although the call is correct. The badge must show the code of one peer, or say that a mesh has one code per pair, and the alarm must stay per pair (coderobe 17:19).
- Show the per peer volume slider and the `e2e ready` badge only while the pointer is over that tile, so a full room is a picture and not a panel. On a touch screen there is no hover, so the control must open on a tap (coderobe 17:40).
- Give the per peer volume slider a natural scale: today the gain is linear in amplitude, so the top half of the travel changes little and the bottom half jumps to silence. Map the slider position to loudness, for example a power curve, keep 100 percent at unity, and keep the stored setting in the same unit (coderobe 17:40).
- Decide the policy for custom room names: a guessed name lets people drop in, and the point of random ids is that they cannot (coderobe).
- Decide if a bot or a text peer can take part in a room: today only browsers join one, so the voice bridge from the jitsi port has no place here yet (open question, not started).
- Add a camera and microphone picker: the join asks for the camera and the microphone but always takes the default devices. Choose the device before the join and keep the choice beside the name. On Android and GrapheneOS the default microphone can be a device that gives silence, so this may be the same fault as the silent phone call (katia 14:33).
- Add a sound switch: the four cues and the lost connection chime are always on, they can only be made quiet by hand.
- Extend the stats panel with jitter, packet loss and a short history graph; today it shows bitrates, round trip time and the path.
- Give the per peer volume a stable identity beyond the name: two guests with the same name share one stored setting.
- Client side mesh transcription: one volunteer peer runs ASR on the incoming streams inside the page and sends the text as sealed chat, with a label that says who transcribed. Model: vosk small, 68 MB down, one model only. Moonshine base (274 MB) is refused as too heavy (coderobe 17:23). Addendum (coderobe 17:23): the feature is off by default and nothing is preloaded. The tab fetches the 68 MB model only when the user asks for transcription, shows the download, and keeps it in the browser cache; a refused download leaves the call working, because a heavy page is bad for every guest. One engine only: vosk has its own API and quality, so moonshine would be a second integration, not a setting (coderobe 17:25).
