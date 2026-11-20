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

// SPIKE: the picture of a tab of a headless browser, encoded here and sent on as Annex B
// access units. The tab's size is the picture's; a keyframe comes when one is asked for.
let hardwareFails = false;
const keyframes = new Set();
// What each tab's video is to spend, as the session last said.
const qualities = new Map();
const base64 = (bytes) => {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000));
  return btoa(text);
};
const watch = async (track, tab) => {
  // Only the latest frame waits: an older one is of a moment that has passed.
  const frames = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
  let encoder = null;
  let size = "";
  let spends = "";
  let last = -Infinity;
  const make = async (width, height) => {
    const made = new VideoEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        tell({ type: "video.packet", tabId: tab, key: chunk.type === "key", width, height, data: base64(bytes) });
      },
      error: (error) => {
        // An encoder on the GPU that does not work here is not tried again.
        if (made.how === "hardware") {
          hardwareFails = true;
          size = "";
          return;
        }
        tell({ type: "video.failed", tabId: tab, error: String(error?.message ?? error) });
      },
    });
    const { bitrate = 2_500_000, fps = 30 } = qualities.get(tab) ?? {};
    const config = { codec: "avc1.640033", width, height, bitrate, framerate: fps, latencyMode: "realtime", avc: { format: "annexb" } };
    // On the GPU where the browser encodes there, and else as it can.
    const hardware = { ...config, hardwareAcceleration: "prefer-hardware" };
    const on = !hardwareFails && (await VideoEncoder.isConfigSupported(hardware).catch(() => null))?.supported === true;
    made.configure(on ? hardware : config);
    made.how = on ? "hardware" : "software";
    return made;
  };
  for (;;) {
    const { value: frame, done } = await frames.read();
    if (done) break;
    const width = frame.displayWidth & ~1;
    const height = frame.displayHeight & ~1;
    const { bitrate = 2_500_000, fps = 30 } = qualities.get(tab) ?? {};
    // No more frames than asked for: each has more of the bitrate.
    if (frame.timestamp - last < 1_000_000 / fps - 3000) {
      frame.close();
      continue;
    }
    last = frame.timestamp;
    if (`${width}x${height}` !== size || `${bitrate}@${fps}` !== spends) {
      spends = `${bitrate}@${fps}`;
      if (encoder !== null && encoder.state !== "closed") encoder.close();
      encoder = await make(width, height);
      size = `${width}x${height}`;
      keyframes.add(tab);
      tell({ type: "video.started", tabId: tab, encoder: `${size} ${encoder.how} ${spends}` });
    }
    // Frames the encoder has no time for are left out, down to the latest.
    if (encoder.state === "configured" && encoder.encodeQueueSize < 2) {
      encoder.encode(frame, { keyFrame: keyframes.delete(tab) });
    }
    frame.close();
  }
  if (encoder !== null && encoder.state !== "closed") encoder.close();
};

// What is taken of each tab, to let go of it when its picture is to have another size.
const held = new Map();
const tap = async (stream, tab, sound, video) => {
  const source = { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: stream } };
  const sized = video ? { minWidth: video.width, maxWidth: video.width, minHeight: video.height, maxHeight: video.height, maxFrameRate: 60 } : {};
  const media = await navigator.mediaDevices.getUserMedia({
    audio: sound ? source : false,
    video: video ? { mandatory: { ...source.mandatory, ...sized } } : false,
  });
  held.set(tab, media);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    for (const track of media.getTracks()) track.stop();
    if (held.get(tab) === media) held.delete(tab);
    taps.delete(tab);
    tell({ type: "sound.untapped", tabId: tab });
  };
  const [picture] = media.getVideoTracks();
  if (picture !== undefined) {
    watch(picture, tab)
      .catch((error) => tell({ type: "video.failed", tabId: tab, error: String(error?.message ?? error) }))
      .finally(end);
  }
  const [track] = media.getAudioTracks();
  taps.add(tab);
  tell({ type: "sound.tapped", tabId: tab });
  if (track === undefined) return;

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
      end();
    });
};

chrome.runtime.onMessage.addListener((message, _from, answer) => {
  if (message.keyframe !== undefined) keyframes.add(message.keyframe);
  if (message.quality !== undefined) qualities.set(message.quality, { bitrate: message.bitrate, fps: message.fps });
  if (message.untap !== undefined) for (const track of held.get(message.untap)?.getTracks() ?? []) track.stop();
  if (message.tap === undefined) return false;
  tap(message.tap, message.tab, message.sound ?? true, message.video ?? false).then(
    () => answer({ tapped: true }),
    (error) => answer({ tapped: false, error: String(error?.message ?? error) }),
  );
  return true;
});
