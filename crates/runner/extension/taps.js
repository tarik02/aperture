// A tab that plays nothing sends nothing. It is quiet below this, of a full scale of 1,
// and its sound is sent on for this long after, so that what fades out does.
const QUIET = 1e-4;
const TAIL_US = 500_000;

const taps = new Set();
let worker = null;
const tell = (message) => {
  if (worker === null) {
    worker = chrome.runtime.connect({ name: "taps" });
    worker.onDisconnect.addListener(() => {
      worker = null;
    });
    // A worker that started again has to hear of every tap.
    for (const tab of taps) worker.postMessage({ type: "sound.tapped", tabId: tab });
  }
  worker.postMessage(message);
};

const tap = async (stream, tab) => {
  const media = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: stream } } });
  const [track] = media.getAudioTracks();
  taps.add(tab);
  tell({ type: "sound.tapped", tabId: tab });

  const encoder = new AudioEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      tell({ type: "sound.packet", tabId: tab, data: btoa(String.fromCharCode(...bytes)) });
    },
    error: () => track.stop(),
  });
  const samples = new MediaStreamTrackProcessor({ track }).readable.getReader();
  let scratch = new Float32Array(0);
  let loudAt = -Infinity;
  const listen = async () => {
    for (;;) {
      const { value: audio, done } = await samples.read();
      if (done) return;
      if (encoder.state === "unconfigured") {
        encoder.configure({ codec: "opus", sampleRate: audio.sampleRate, numberOfChannels: audio.numberOfChannels, bitrate: 96_000, opus: { frameDuration: 20_000 } });
      }
      if (encoder.state !== "configured") return audio.close();
      let loud = false;
      for (let plane = 0; plane < audio.numberOfChannels && !loud; plane++) {
        const size = audio.allocationSize({ planeIndex: plane, format: "f32-planar" }) / 4;
        if (scratch.length < size) scratch = new Float32Array(size);
        audio.copyTo(scratch, { planeIndex: plane, format: "f32-planar" });
        for (let at = 0; at < size && !loud; at++) loud = Math.abs(scratch[at]) > QUIET;
      }
      if (loud) loudAt = audio.timestamp;
      if (audio.timestamp - loudAt <= TAIL_US) encoder.encode(audio);
      audio.close();
    }
  };
  listen()
    .catch(() => {})
    .finally(() => {
      track.stop();
      if (encoder.state !== "closed") encoder.close();
      taps.delete(tab);
      tell({ type: "sound.untapped", tabId: tab });
    });
};

chrome.runtime.onMessage.addListener((message, _from, answer) => {
  if (message.tap === undefined) return false;
  tap(message.tap, message.tab).then(
    () => answer({ tapped: true }),
    (error) => answer({ tapped: false, error: String(error?.message ?? error) }),
  );
  return true;
});
