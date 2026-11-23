/*
 The lab page's proof of the cipher.
*/

import { send } from './menu.js';
import { ask } from './media.js';
import { iceServers } from './peers.js';
import { b64e } from './sealed.js';

// ---------------------------------------------------------------- lab proof
// runLab answers one question with the real code path: an encrypted video
// stream whose receiver starts with a wrong key. It must receive RTP but decode
// nothing, and decoding must start only after the right key is installed live.
// The browser test drives it through window.e2eApp; the UI never calls it.
export async function runLab() {
  const worker = new Worker('/e2e-transform.js');
  const messages = [];
  worker.onmessage = (event) => messages.push(event.data);

  const key = b64e(crypto.getRandomValues(new Uint8Array(32)));
  const wrong = b64e(crypto.getRandomValues(new Uint8Array(32)));
  worker.postMessage({ type: 'keys', pair: 'lab', peer: 'lab', enc: key, dec: wrong });

  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const paint = canvas.getContext('2d');
  let tick = 0;
  const draw = () => {
    tick++;
    paint.fillStyle = 'hsl(' + ((tick * 7) % 360) + ' 70% 40%)';
    paint.fillRect(0, 0, 320, 180);
    paint.fillStyle = '#fff';
    paint.font = '20px monospace';
    paint.fillText('pq frame ' + tick, 16, 40);
  };
  draw();
  const timer = setInterval(draw, 33);
  const videoStream = canvas.captureStream(30);

  const audioCtx = new AudioContext();
  const osc = audioCtx.createOscillator();
  osc.frequency.value = 440;
  const dest = audioCtx.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  const stream = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);

  const pc1 = new RTCPeerConnection({ iceServers: [] });
  const pc2 = new RTCPeerConnection({ iceServers: [] });
  const sink = new MediaStream();
  pc2.ontrack = (event) => sink.addTrack(event.track);
  // A sink element makes the receiver decode even without a visible tile.
  const labVideo = document.createElement('video');
  labVideo.muted = true;
  labVideo.autoplay = true;
  labVideo.playsInline = true;
  labVideo.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
  labVideo.srcObject = sink;
  document.body.appendChild(labVideo);
  labVideo.play().catch(() => {});

  const gathered = (pc) => new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve(null);
      return;
    }
    const done = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', done);
        resolve(null);
      }
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(() => resolve(null), 4000);
  });

  for (const track of stream.getTracks()) {
    const sender = pc1.addTrack(track, stream);
    sender.transform = new RTCRtpScriptTransform(worker, {
      pair: 'lab', peer: 'lab', dir: 'send', kind: track.kind, from: 'lab',
    });
  }

  await pc1.setLocalDescription();
  await gathered(pc1);
  await pc2.setRemoteDescription(pc1.localDescription);
  for (const receiver of pc2.getReceivers()) {
    receiver.transform = new RTCRtpScriptTransform(worker, {
      pair: 'lab', peer: 'lab', dir: 'recv', kind: receiver.track.kind, from: 'lab',
    });
  }
  await pc2.setLocalDescription();
  await gathered(pc2);
  await pc1.setRemoteDescription(pc2.localDescription);

  const read = async () => {
    const out = { videoDecoded: 0, audioDecoded: 0, packets: 0, bytes: 0 };
    const report = await pc2.getStats();
    report.forEach((r) => {
      if (r.type !== 'inbound-rtp') return;
      out.packets += r.packetsReceived || 0;
      out.bytes += r.bytesReceived || 0;
      if (r.kind === 'video') out.videoDecoded += r.framesDecoded || 0;
      if (r.kind === 'audio') out.audioDecoded += r.framesDecoded || 0;
    });
    return out;
  };

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const before = await read();
  const early = messages.filter((m) => m.type === 'stats');

  worker.postMessage({ type: 'keys', pair: 'lab', peer: 'lab', dec: key });
  for (const receiver of pc2.getReceivers()) {
    const ask = (receiver as any);
    if (ask.requestKeyFrame) ask.requestKeyFrame();
  }
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const after = await read();
  const late = messages.filter((m) => m.type === 'stats');

  clearInterval(timer);
  osc.stop();
  audioCtx.close().catch(() => {});
  labVideo.remove();
  for (const t of stream.getTracks()) t.stop();
  pc1.close();
  pc2.close();
  worker.terminate();

  const sum = (list, dir) => list.filter((m) => m.dir === dir).reduce((n, m) => n + m.ok, 0);
  return {
    before,
    after,
    packetsArrived: before.packets > 0,
    decodedNothingWithoutKey: before.videoDecoded === 0 && before.audioDecoded === 0,
    decryptedAfterKey: after.videoDecoded > 0 || after.audioDecoded > 0,
    refusedFrames: early.reduce((n, m) => n + (m.fail || 0), 0),
    openedFrames: sum(late, 'recv'),
    samples: messages.filter((m) => m.type === 'sample').slice(0, 6),
    workerErrors: messages.filter((m) => m.type === 'error'),
  };
}
