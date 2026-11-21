import * as Effect from "effect/Effect";

/** How far ahead of now sound starts that came too late for its turn, in seconds. */
const AHEAD = 0.06;
/** Sound that would wait longer than this is left out: it stays with the picture. */
const WAIT_MOST = 0.4;

export interface Sound {
  /**
   * Turns the sound on or off. A browser plays none before a click or a key: sound that is
   * turned on earlier starts with the first of those.
   */
  readonly turn: (on: boolean) => void;
  /** The sound as a track of a WebRTC connection, or none when that connection ended. */
  readonly track: (track: MediaStreamTrack | undefined) => void;
  /** An Opus packet of the sound that comes on the session socket. */
  readonly hear: (timeUs: bigint, data: Uint8Array) => void;
}

/**
 * The session's sound. With a WebRTC connection it comes on a track of that; otherwise as
 * packets on the session socket, which are decoded and played one after the other.
 */
export const make = Effect.fn("Sound.make")(function* () {
  const speaker = typeof Audio === "undefined" ? undefined : new Audio();
  if (speaker !== undefined) {
    speaker.autoplay = true;
    speaker.muted = true;
  }
  let on = false;
  let context: AudioContext | undefined;
  let decoder: AudioDecoder | undefined;
  let playAt = 0;

  const play = (ears: AudioContext, audio: AudioData) => {
    const buffer = ears.createBuffer(
      audio.numberOfChannels,
      audio.numberOfFrames,
      audio.sampleRate,
    );
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      audio.copyTo(buffer.getChannelData(channel), { planeIndex: channel, format: "f32-planar" });
    }
    audio.close();
    const now = ears.currentTime;
    if (playAt < now) {
      playAt = now + AHEAD;
    }
    if (playAt > now + WAIT_MOST) {
      return;
    }
    const source = ears.createBufferSource();
    source.buffer = buffer;
    source.connect(ears.destination);
    source.start(playAt);
    playAt += buffer.duration;
  };

  const listen = () => {
    if (typeof AudioContext === "undefined" || typeof AudioDecoder === "undefined") {
      return undefined;
    }
    context ??= new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
    const ears = context;
    if (decoder?.state !== "configured") {
      decoder = new AudioDecoder({
        output: (audio) => play(ears, audio),
        // A packet that does not decode is a gap in the sound; the next one is heard.
        error: () => {},
      });
      decoder.configure({ codec: "opus", sampleRate: 48_000, numberOfChannels: 2 });
    }
    return decoder;
  };

  const start = () => {
    if (!on) {
      return;
    }
    // Refused where there is nothing to play yet, and before a click.
    void speaker?.play().catch(() => {});
    void context?.resume().catch(() => {});
  };
  const gestures = new AbortController();
  if (typeof document !== "undefined") {
    for (const gesture of ["pointerdown", "keydown"]) {
      document.addEventListener(gesture, start, { capture: true, signal: gestures.signal });
    }
  }

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      on = false;
      gestures.abort();
      if (decoder !== undefined && decoder.state !== "closed") {
        decoder.close();
      }
      // Closing is refused only for a context that is closed already.
      void context?.close().catch(() => {});
      if (speaker !== undefined) {
        speaker.pause();
        speaker.srcObject = null;
      }
    }),
  );

  return {
    turn: (wanted) => {
      on = wanted;
      if (speaker !== undefined) {
        speaker.muted = !wanted;
      }
      start();
    },
    track: (track) => {
      if (speaker !== undefined) {
        // The sound plays apart from the picture, which would wait for it otherwise.
        speaker.srcObject = track === undefined ? null : new MediaStream([track]);
      }
    },
    hear: (timeUs, data) => {
      if (!on) {
        return;
      }
      const heard = listen();
      if (heard === undefined) {
        return;
      }
      try {
        heard.decode(new EncodedAudioChunk({ type: "key", timestamp: Number(timeUs), data }));
      } catch {
        // The decoder closed on a packet before this one; the next packet makes another.
      }
    },
  } satisfies Sound;
});
