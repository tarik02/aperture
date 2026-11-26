import { proto } from "@aperture-browser/executor-client";
import * as UrlPath from "@aperture-browser/shared/url-path";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Executor } from "../src/executor.ts";
import * as Node from "../src/node.ts";
import { suite } from "../src/suite.ts";
import { ready, snapshot, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";

// The viewer is a person's browser: one outside any session, with a network of its own.
const node = Layer.mergeAll(Node.layer({ features: ["cdp"] }), ViewerLive.layer);

/** A page that is told from the others by its title, and by its address: tabs come back by it. */
const page = (title: string) =>
  `data:text/html,<title>${title}</title><body style='background:%23246'><h1>${title}</h1>`;

const PNG = [0x89, 0x50, 0x4e, 0x47];
const isPng = (bytes: Uint8Array) => PNG.every((byte, at) => bytes[at] === byte);

const same = (one: Uint8Array, other: Uint8Array) =>
  one.length === other.length && one.every((byte, at) => byte === other[at]);

/** What a node kept of a session's tabs as it was last suspended. */
const KeptTabs = Schema.Struct({
  watched: Schema.NullOr(Schema.Number),
  tabs: Schema.Array(
    Schema.Struct({
      tab: Schema.Number,
      title: Schema.String,
      url: Schema.String,
      picture: Schema.Boolean,
    }),
  ),
});

suite(node)("the tab a session's viewers watched last", (it) => {
  let session: string;
  let watched: Node.Opened;
  let newest: Node.Opened;

  /** The tab a new viewer of the session watches, as it watches it. */
  const opensOn = (query: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const viewer = yield* Viewer;
      const opened = yield* Node.watch(viewer, executor, session, query);
      yield* ready(opened);
      const tab = yield* snapshot(opened, "s.selected", Schema.Number);
      yield* opened.close;
      return tab;
    });

  it.effect("a viewer asked to watch a tab watches it, though it is not the newest", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      session = (yield* executor.client.sessions.create()).id;
      watched = yield* Node.open(executor, session, page("watched"));
      newest = yield* Node.open(executor, session, page("newest"));

      expect(yield* opensOn({ tab: String(watched.tab) })).toBe(watched.tab);
      const all = yield* Node.targets(executor, session);
      expect(all.at(-1)?.id).toBe(newest.id);
    }),
  );

  it.effect("opening the session again shows the tab watched last, not the newest", () =>
    Effect.gen(function* () {
      expect(yield* opensOn()).toBe(watched.tab);
    }),
  );

  it.effect("a suspended session keeps a picture of each tab, its own of the one watched", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const suspended = yield* executor.client.sessions.suspend(session);
      expect(suspended.state).toBe(proto.SessionState.SUSPENDED);

      const told = yield* Node.bytes(executor, session, "/previews");
      const kept = yield* Schema.decodeUnknownEffect(KeptTabs)(
        JSON.parse(new TextDecoder().decode(told)),
      );
      expect(kept.watched).toBe(watched.tab);
      expect(kept.tabs.map((tab) => tab.tab)).toEqual(
        expect.arrayContaining([watched.tab, newest.tab]),
      );
      expect(kept.tabs.find((tab) => tab.tab === newest.tab)?.title).toBe("newest");
      expect(kept.tabs.every((tab) => tab.picture)).toBe(true);

      const own = yield* Node.bytes(executor, session, "/preview.png");
      const ofWatched = yield* Node.bytes(
        executor,
        session,
        UrlPath.make`/previews/${String(watched.tab)}`,
      );
      expect(isPng(ofWatched)).toBe(true);
      expect(same(own, ofWatched)).toBe(true);
      // Asking for them leaves the session at rest.
      expect((yield* executor.client.sessions.get(session)).state).toBe(
        proto.SessionState.SUSPENDED,
      );
    }),
  );

  it.effect("and resumed, it is opened on the tab watched last again", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      yield* executor.client.sessions.resume(session);
      yield* Node.targetsOnce(executor, session, "the tabs being back", (all) =>
        [watched.tab, newest.tab].every((tab) => all.some((target) => target.tab === tab)),
      );
      expect(yield* opensOn()).toBe(watched.tab);
    }),
  );
});
