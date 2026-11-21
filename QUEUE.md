# Queue

One line per work item. The top item is the most important.

## In work, not live yet


## Open

- The per peer volume keeps a guest name on disk and has no identity beyond it: `rooms.vol.<name>` lists who a guest called on a shared machine, and two guests with one name share one setting. Key the setting with the peer key fingerprint or the peer id, keep no name on disk, and keep the setting in memory for the call if that is too much (katia 18:53, coderobe 18:53).
- A real desktop window on the login page: the lobby window must move around the screen like a real desktop window. Drag by the title bar, keep the whole window inside the viewport, allow the drag on a touch screen, and remember the place for the guest. The call stage stays maximised and takes no drag (katia 18:55, 19:13, coderobe 19:14).
- Show the per peer volume slider and the `e2e ready` badge only while the pointer is over that tile, so a full room is a picture and not a panel. On a touch screen there is no hover, so the control must open on a tap (coderobe 17:40).
- Give the per peer volume slider a natural scale: today the gain is linear in amplitude, so the top half of the travel changes little and the bottom half jumps to silence. Map the slider position to loudness, for example a power curve, keep 100 percent at unity, and keep the stored setting in the same unit (coderobe 17:40).
- Client side mesh transcription: one volunteer peer runs ASR on the incoming streams inside the page and sends the text as sealed chat, with a label that says who transcribed. Model: vosk small, 68 MB down, one model only. Moonshine base (274 MB) is refused as too heavy (coderobe 17:23). Addendum (coderobe 17:23): the feature is off by default and nothing is preloaded. The tab fetches the 68 MB model only when the user asks for transcription, shows the download, and keeps it in the browser cache; a refused download leaves the call working, because a heavy page is bad for every guest. One engine only: vosk has its own API and quality, so moonshine would be a second integration, not a setting (coderobe 17:25).
- Add a performance slider: one control that trades picture quality against bandwidth and compute, as the jitsi version has. The slider must also set the outgoing resolution of the camera, so a weak network or a weak machine sends fewer pixels instead of dropping sound and frames. One stored value per guest, and the default must stay the full quality path (katia 18:43).
- Make a posted URL clickable in the chat: a guest who types or pastes a link gets a clickable link, http and https only, with the target shown on hover. A link is not a preview: no page is fetched and no image is loaded until a guest clicks it, because a link that phones home tells the other side who reads the room (coderobe 21:10, 21:13).
- A waiting room, which an admin can turn on for the room. A new guest waits outside the room until a guest inside lets them in. While the guest waits, the room can see and hear them, and the screen tells the waiting guest in clear words that the camera and the microphone are on and that the room can see and hear them before they are let in (katia 00:27).
- Add a sound switch: the four cues and the lost connection chime are always on, they can only be made quiet by hand. Asked by ax, katia put it at the bottom of the queue (22:38).
