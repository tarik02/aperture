import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import * as Effect from "effect/Effect";
import type { CdpError } from "./cdp.ts";
import type { RunnerService } from "./runner.ts";
import { until } from "./wait.ts";

/** A site that is told to go around the session's proxy, to see whether anything lets it. */
export const AROUND_PROXY = "example.org";

/** Has the browser make the connections to `AROUND_PROXY` itself, not through its proxy. */
export const aroundProxy = `--browser-arg=--proxy-bypass-list=${AROUND_PROXY}`;

/** A STUN server anyone may ask what address they are seen at. */
export const STUN = "stun.l.google.com";

const TUN = "/dev/net/tun";

const usable = (path: string, mode: number) => {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
};

/** Whether the runner would find pasta, which it takes from `APERTURE_PASTA` or the path. */
const pastaFound = () => {
  const named = process.env["APERTURE_PASTA"] ?? "pasta";
  if (isAbsolute(named)) {
    return usable(named, constants.X_OK);
  }
  const places = (process.env["PATH"] ?? "").split(delimiter);
  return places.some((place) => usable(join(place, named), constants.X_OK));
};

/**
 * Why no browser gets a network of its own on this machine, which anything but proxied TCP
 * without UDP takes; undefined where one does.
 */
export const noOwnNetwork = (): string | undefined => {
  if (!pastaFound()) {
    return "pasta is neither what APERTURE_PASTA names nor on the path";
  }
  if (!usable(TUN, constants.R_OK | constants.W_OK)) {
    return `${TUN} is not there to read and write`;
  }
  return undefined;
};

/** The session's first tab, as its browser's DevTools drive it. */
export interface Tab {
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly evaluate: (expression: string) => Effect.Effect<any, CdpError>;
  /** Goes to an address and gives the title of what is there once it is loaded. */
  readonly open: (url: string) => Effect.Effect<string, Error>;
}

export const firstTab = (runner: RunnerService) =>
  Effect.gen(function* () {
    const targets = yield* runner.targets;
    const first = targets[0];
    if (first === undefined) {
      return yield* Effect.fail(new Error("the session has no tab"));
    }
    const cdp = yield* runner.cdp;
    const page = yield* cdp.attach(first.id);
    const open: Tab["open"] = (url) =>
      Effect.gen(function* () {
        // The answer comes once the page is the new one, or an error page in its place.
        yield* page.call("Page.navigate", { url });
        yield* until(
          `${url} being loaded`,
          page.evaluate("document.readyState === 'complete'"),
          30_000,
        );
        return (yield* page.evaluate("document.title")) as string;
      });
    return { evaluate: page.evaluate, open } satisfies Tab;
  });

/**
 * An expression for a page: the kinds of ICE candidates the browser gathers with a STUN
 * server, joined by commas. `srflx` is among them when the server answered over UDP.
 */
export const iceCandidates = (server: string) => `
  new Promise((done) => {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:${server}:19302" }] });
    const kinds = [];
    peer.createDataChannel("x");
    peer.onicecandidate = (event) => {
      if (event.candidate) kinds.push(event.candidate.type);
      else done(kinds.join(","));
    };
    peer.createOffer().then((offer) => peer.setLocalDescription(offer));
    setTimeout(() => done(kinds.join(",")), 8000);
  })
`;

/** An expression for a page: whether `AROUND_PROXY` is `reached` or `refused`. */
export const reachesAroundProxy = `
  fetch("https://${AROUND_PROXY}/", { mode: "no-cors", signal: AbortSignal.timeout(6000) }).then(
    () => "reached",
    () => "refused",
  )
`;
