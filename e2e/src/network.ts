// Effect resolves no names: the one address a check needs is asked of Node's resolver.
// oxlint-disable-next-line import/no-nodejs-modules
import { lookup } from "node:dns/promises";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Cdp from "./cdp.ts";
import type { RunnerService } from "./runner.ts";
import { type TimedOut, until } from "./wait.ts";

/** A site that is told to go around the session's proxy, to see whether anything lets it. */
export const AROUND_PROXY = "example.org";

/** Has the browser make the connections to `AROUND_PROXY` itself, not through its proxy. */
export const aroundProxy = `--browser-arg=--proxy-bypass-list=${AROUND_PROXY}`;

/** A STUN server anyone may ask what address they are seen at. */
export const STUN = "stun.l.google.com";

const TUN = "/dev/net/tun";

/** Whether the file is there for anyone at all to run. */
const runs = (fs: FileSystem.FileSystem, path: string) =>
  fs.stat(path).pipe(
    Effect.map((file) => file.type === "File" && (file.mode & 0o111) !== 0),
    Effect.orElseSucceed(() => false),
  );

/** Whether the runner would find pasta, which it takes from `APERTURE_PASTA` or the path. */
const pastaFound = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const named = yield* Config.String("APERTURE_PASTA").pipe(Config.withDefault("pasta"));
  if (path.isAbsolute(named)) {
    return yield* runs(fs, named);
  }
  const places = yield* Config.String("PATH").pipe(Config.withDefault(""));
  for (const place of places.split(":")) {
    if (yield* runs(fs, path.join(place, named))) {
      return true;
    }
  }
  return false;
});

/**
 * Why no browser gets a network of its own on this machine, which anything but proxied TCP
 * without UDP takes; undefined where one does.
 */
const noOwnNetwork = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* pastaFound)) {
    return "pasta is neither what APERTURE_PASTA names nor on the path";
  }
  const usable = yield* fs.access(TUN, { readable: true, writable: true }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  return usable ? undefined : `${TUN} is not there to read and write`;
});

/**
 * Whether this machine gives no browser a network of its own; it says why where it does
 * not, for whoever reads what checks were skipped. A suite asks before it has its checks.
 */
export const lacksOwnNetwork = noOwnNetwork.pipe(
  Effect.tap((unmet) =>
    unmet === undefined
      ? Effect.void
      : Console.warn(`Checks of a browser with a network of its own are skipped: ${unmet}.`),
  ),
  Effect.map((unmet) => unmet !== undefined),
);

/** A name that no resolver of this machine knows an address of. */
export class NoAddress extends Schema.TaggedError<NoAddress>()("NoAddress", {
  name: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `${this.name} has no address: ${this.reason}`;
  }
}

/** The IPv4 address of a name, as this machine resolves it. */
export const addressOf = (name: string) =>
  Effect.tryPromise({
    try: () => lookup(name, { family: 4 }),
    catch: (cause) => new NoAddress({ name, reason: String(cause) }),
  }).pipe(Effect.map((found) => found.address));

/** The session has no tab to drive. */
export class NoTab extends Schema.TaggedError<NoTab>()("NoTab", {}) {
  override get message() {
    return "the session has no tab";
  }
}

/** The session's first tab, as its browser's DevTools drive it. */
export interface Tab {
  readonly evaluate: Cdp.Evaluate;
  /** Goes to an address and gives the title of what is there once it is loaded. */
  readonly open: (url: string) => Effect.Effect<string, Cdp.CdpError | TimedOut>;
  /**
   * Goes to an address and tells whether what loaded is of the site it names: a page that
   * did not load is the browser's own, of no site. What the site answers with is the
   * site's to say, and not always its page to a machine that asks often.
   */
  readonly reaches: (url: string) => Effect.Effect<boolean, Cdp.CdpError | TimedOut>;
}

export const firstTab = (runner: RunnerService) =>
  Effect.gen(function* () {
    const targets = yield* runner.targets;
    const first = targets[0];
    if (first === undefined) {
      return yield* new NoTab();
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
          "30 seconds",
        );
        return yield* page.evaluate("document.title", Schema.String);
      });
    const reaches: Tab["reaches"] = (url) =>
      open(url).pipe(
        Effect.andThen(
          page.evaluate(
            `location.hostname === ${JSON.stringify(new URL(url).hostname)}`,
            Schema.Boolean,
          ),
        ),
      );
    return { evaluate: page.evaluate, open, reaches } satisfies Tab;
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
