import type { PictureWay, VideoFormat } from "./model.ts";

/**
 * What a decoder is asked for, by the form of the frames. Without a description the
 * frames are read as Annex B, which they are.
 */
export const CODECS: Readonly<Record<VideoFormat, string>> = {
  h264: "avc1.42e01f",
  "full-chroma": "avc1.f4001f",
  h265: "hev1.1.6.L153.B0",
  vp9: "vp09.00.51.08",
  "vp9-full-chroma": "vp09.01.51.08.03",
  av1: "av01.0.13M.08",
};

type Carries = (codec: RTCRtpCodec) => boolean;

/** What a WebRTC connection calls the formats it carries; it carries no H.264 4:4:4. */
const RTC_CODECS: Readonly<Partial<Record<VideoFormat, Carries>>> = {
  h264: (codec) => codec.mimeType === "video/H264",
  h265: (codec) => codec.mimeType === "video/H265",
  vp9: (codec) =>
    codec.mimeType === "video/VP9" && /profile-id=0/u.test(codec.sdpFmtpLine ?? "profile-id=0"),
  "vp9-full-chroma": (codec) =>
    codec.mimeType === "video/VP9" && /profile-id=1/u.test(codec.sdpFmtpLine ?? ""),
  av1: (codec) => codec.mimeType === "video/AV1",
};

const ALL = Object.keys(CODECS) as VideoFormat[];

/** The ways this environment can take a picture, best first. */
export const waysHere = (): PictureWay[] => {
  const ways: PictureWay[] = [];
  if (typeof RTCPeerConnection !== "undefined") {
    ways.push("video");
  }
  if (typeof VideoDecoder !== "undefined") {
    ways.push("frames");
  }
  ways.push("tiles");
  return ways;
};

const decodes = async (format: VideoFormat) => {
  try {
    const { supported } = await VideoDecoder.isConfigSupported({ codec: CODECS[format] });
    return supported === true;
  } catch {
    return false;
  }
};

/** The formats this browser takes the way the picture comes. */
export const decodable = async (way: PictureWay): Promise<VideoFormat[]> => {
  if (way === "video") {
    const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
    return ALL.filter((format) => {
      const carries = RTC_CODECS[format];
      return carries !== undefined && codecs.some(carries);
    });
  }
  if (way === "frames") {
    const supported = await Promise.all(ALL.map(decodes));
    return ALL.filter((_, at) => supported[at]);
  }
  return [];
};
