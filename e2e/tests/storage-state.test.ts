import { type Address, SessionHttp } from "@aperture-browser/session-client/effect";
import { expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Attached, CdpError } from "../src/cdp.ts";
import * as Runner from "../src/runner.ts";
import * as Site from "../src/site.ts";
import { suite } from "../src/suite.ts";
import { type TimedOut, until } from "../src/wait.ts";

// A page without an icon is asked for one some time after it loaded, which would count
// as the site being asked for something.
const NO_ICON = '<link rel="icon" href="data:,">';

/** Stores what a state carries, and says `stored` in its title once all of it is kept. */
const STORING_PAGE = `${NO_ICON}<title>set</title><script>
  localStorage.setItem('k', 'v');
  localStorage.setItem('unicode', 'привіт "q"');
  document.cookie = 'c=1; max-age=3600; path=/';
  const opening = indexedDB.open('auth', 3);
  opening.onupgradeneeded = () => {
    const kept = opening.result.createObjectStore('kept', { keyPath: 'id' });
    kept.createIndex('by', 'by', { unique: false });
    opening.result.createObjectStore('loose');
    opening.result.createObjectStore('counted', { autoIncrement: true });
  };
  opening.onsuccess = () => {
    const writing = opening.result.transaction(['kept', 'loose', 'counted'], 'readwrite');
    const cyclic = { name: 'c' };
    cyclic.self = cyclic;
    writing.objectStore('kept').put({
      id: 1,
      by: 'a',
      when: new Date(86400000),
      bytes: new Uint8Array([1, 2, 250]),
      big: 5n,
      none: undefined,
      cyc: cyclic,
    });
    writing.objectStore('kept').put({ id: 2, by: 'b', plain: [1, 'two', { three: 3 }] });
    writing.objectStore('loose').put('abc', 'token');
    writing.objectStore('loose').put(new Uint16Array([1, 65535]).buffer, [1, 'k']);
    writing.objectStore('counted').put({ n: 1 });
    writing.oncomplete = () => {
      opening.result.close();
      document.title = 'stored';
    };
  };
</script>`;

const READING_PAGE = `${NO_ICON}<title>read</title>`;

/**
 * Reads the `auth` database in the page and tells it as JSON does: what JSON does not
 * hold is told by what it is. The database stays open in the page afterwards.
 */
const READ_DATABASE = `new Promise((found) => {
  const opening = indexedDB.open('auth');
  opening.onupgradeneeded = () => found('no database');
  opening.onsuccess = () => {
    const database = opening.result;
    const reading = database.transaction(['kept', 'loose', 'counted']);
    const kept = reading.objectStore('kept');
    const loose = reading.objectStore('loose');
    const told = {
      version: database.version,
      stores: [...database.objectStoreNames],
      indexes: [...kept.indexNames],
    };
    kept.get(1).onsuccess = (got) => {
      const record = got.target.result;
      told.rich = {
        by: record.by,
        when: record.when instanceof Date && record.when.getTime(),
        bytes: record.bytes instanceof Uint8Array && [...record.bytes],
        big: typeof record.big === 'bigint' && String(record.big),
        none: 'none' in record && record.none === undefined,
        cyc: record.cyc.self === record.cyc && record.cyc.name,
      };
    };
    kept.index('by').get('b').onsuccess = (got) => {
      told.byIndex = got.target.result;
    };
    loose.get('token').onsuccess = (got) => {
      told.token = got.target.result;
    };
    loose.get([1, 'k']).onsuccess = (got) => {
      const buffer = got.target.result;
      told.buffer = buffer instanceof ArrayBuffer && [...new Uint16Array(buffer)];
    };
    reading.objectStore('counted').getAllKeys().onsuccess = (got) => {
      told.counted = got.target.result;
    };
    reading.oncomplete = () => found(told);
  };
})`;

/** Keeps a file in a database of its own, and says `blob` in its title once it is kept. */
const STORE_A_FILE = `(() => {
  const opening = indexedDB.open('files');
  opening.onupgradeneeded = () => opening.result.createObjectStore('f');
  opening.onsuccess = () => {
    const writing = opening.result.transaction('f', 'readwrite');
    writing.objectStore('f').put(new Blob(['x']), 'b');
    writing.oncomplete = () => {
      opening.result.close();
      document.title = 'blob';
    };
  };
})()`;

/** A database as a state tells it; a record whole, with whatever it has. */
const StateDatabase = Schema.Struct({
  name: Schema.String,
  version: Schema.Number,
  stores: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      keyPath: Schema.optional(Schema.Unknown),
      autoIncrement: Schema.Boolean,
      indexes: Schema.Array(Schema.Struct({ name: Schema.String })),
      records: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});

const databasesOf = Schema.decodeUnknownEffect(Schema.Array(StateDatabase));

/** What `READ_DATABASE` tells, each part as the checks compare it. */
const Found = Schema.Struct({
  version: Schema.Unknown,
  stores: Schema.Unknown,
  indexes: Schema.Unknown,
  rich: Schema.Unknown,
  byIndex: Schema.Unknown,
  token: Schema.Unknown,
  buffer: Schema.Unknown,
  counted: Schema.Unknown,
});

/** A session with its one tab attached. */
interface Browsing {
  readonly runner: Runner.RunnerService;
  readonly address: Address;
  readonly page: Attached;
  /** Goes to a page of the site and waits until its title is `titled` and the session knows of it. */
  readonly open: (url: string, titled: string) => Effect.Effect<void, CdpError | TimedOut>;
}

interface StageService {
  readonly site: Site.Site;
  /** The session the state is taken out of. */
  readonly source: Browsing;
  /** The session a state without databases is put into. */
  readonly plain: Browsing;
  /** The session a state with databases is put into. */
  readonly withDatabases: Browsing;
}

class Stage extends Context.Service<Stage, StageService>()("@aperture-browser/e2e/StorageStage") {}

const browsing = Effect.gen(function* () {
  const runner = yield* Runner.start({ features: ["cdp"], args: ["--egress-allow", "127.0.0.1"] });
  const cdp = yield* runner.cdp;
  const tab = (yield* runner.targets)[0]!;
  const page = yield* cdp.attach(tab.id);
  const open: Browsing["open"] = (url, titled) =>
    Effect.gen(function* () {
      yield* page.call("Page.navigate", { url });
      yield* until(
        `${url} being titled ${titled}`,
        page.evaluate(`document.title === ${JSON.stringify(titled)}`),
      );
      // An export takes the origins of the pages the session knows its tabs to show, and
      // it learns of a new page a moment after the page is there.
      yield* until(
        `the session telling its tab is at ${url}`,
        runner.targets.pipe(Effect.map((all) => all.some((target) => target.url === url))),
      );
    });
  return {
    runner,
    address: { url: runner.url, token: runner.token },
    page,
    open,
  } satisfies Browsing;
});

const stage = Layer.effect(
  Stage,
  Effect.gen(function* () {
    const site = yield* Site.serve(
      Site.by((request) => Site.html(request.url === "/set" ? STORING_PAGE : READING_PAGE)),
    );
    const [source, plain, withDatabases] = yield* Effect.all([browsing, browsing, browsing], {
      concurrency: "unbounded",
    });
    return { site, source, plain, withDatabases } satisfies StageService;
  }),
);

suite(stage)("storage state, taken out of one session and put into others", (it) => {
  let state: SessionHttp.StorageState;
  let stateWithDatabases: SessionHttp.StorageState;
  /** How often the site was asked once the source's page had stored everything. */
  let askedBefore: number;

  const ofSite = (from: SessionHttp.StorageState, site: Site.Site) =>
    from.origins?.find((origin) => origin.origin === site.url);

  /** An export goes by what the browser holds: it neither asks the site nor opens a tab. */
  const leftNoTrace = Effect.gen(function* () {
    const { site, source } = yield* Stage;
    expect(site.asked().length).toBe(askedBefore);
    expect(yield* source.runner.targets).toHaveLength(1);
  });

  it.effect("a state has the open tab's local storage and the cookies that go to it", () =>
    Effect.gen(function* () {
      const { site, source } = yield* Stage;
      yield* source.open(`${site.url}/set`, "stored");
      askedBefore = site.asked().length;

      state = yield* SessionHttp.exportStorageState(source.address);
      expect(ofSite(state, site)?.localStorage).toEqual(
        expect.arrayContaining([
          { name: "k", value: "v" },
          { name: "unicode", value: 'привіт "q"' },
        ]),
      );
      expect(state.cookies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "c", value: "1", domain: "127.0.0.1", hostOnly: true }),
        ]),
      );
      yield* leftNoTrace;
    }),
  );

  it.effect("an origin that stored nothing is left out, with the cookies that go to it", () =>
    Effect.gen(function* () {
      const { source } = yield* Stage;
      const named = yield* SessionHttp.exportStorageState(source.address, {
        origins: ["https://example.com"],
      });
      expect(named.origins).toEqual([]);
      expect(named.cookies).toEqual([]);
    }),
  );

  it.effect("all cookies are given when asked for", () =>
    Effect.gen(function* () {
      const { source } = yield* Stage;
      const all = yield* SessionHttp.exportStorageState(source.address, {
        origins: ["https://example.com"],
        cookies: "all",
      });
      expect(all.cookies?.map((cookie) => cookie.name)).toContain("c");
    }),
  );

  it.effect("what is no origin is refused", () =>
    Effect.gen(function* () {
      const { source } = yield* Stage;
      const refused = yield* source.runner.request("POST", "/storage-state", {
        origins: ["nonsense"],
      });
      expect(refused.status).toBe(400);
    }),
  );

  it.effect("databases are left out unless asked for, and given as they are made", () =>
    Effect.gen(function* () {
      const { site, source } = yield* Stage;
      expect(ofSite(state, site)?.indexedDB).toBeUndefined();

      stateWithDatabases = yield* SessionHttp.exportStorageState(source.address, {
        indexed_db: true,
      });
      const databases = yield* databasesOf(ofSite(stateWithDatabases, site)?.indexedDB);
      expect(databases).toHaveLength(1);
      const database = databases[0]!;
      expect(database).toMatchObject({ name: "auth", version: 3 });

      const kept = database.stores.find((store) => store.name === "kept");
      expect(kept).toMatchObject({ keyPath: "id", autoIncrement: false });
      expect(kept?.indexes.map((index) => index.name)).toEqual(["by"]);
      const counted = database.stores.find((store) => store.name === "counted");
      expect(counted?.autoIncrement).toBe(true);
      yield* leftNoTrace;
    }),
  );

  it.effect("a record JSON holds goes as it is, and one it does not goes encoded", () =>
    Effect.gen(function* () {
      const { site } = yield* Stage;
      const databases = yield* databasesOf(ofSite(stateWithDatabases, site)?.indexedDB);
      const records = databases[0]!.stores.find((store) => store.name === "kept")!.records;
      const [rich, plain] = records;

      expect(plain).toEqual({
        key: 2,
        value: { id: 2, by: "b", plain: [1, "two", { three: 3 }] },
      });
      expect(rich?.["value"]).toBeUndefined();
      expect(JSON.stringify(rich?.["valueEncoded"])).toContain('"d":"1970-01-02T00:00:00.000Z"');
    }),
  );

  it.effect("a state with more than is carried is refused", () =>
    Effect.gen(function* () {
      const { site, plain } = yield* Stage;
      const refused = yield* plain.runner.request("PUT", "/storage-state", {
        origins: [{ origin: site.url, cacheStorage: [{ name: "db" }] }],
      });
      expect(refused.status).toBe(400);
    }),
  );

  it.effect("the pages of a session the state is put into find the storage and the cookie", () =>
    Effect.gen(function* () {
      const { site, plain } = yield* Stage;
      const put = yield* plain.runner.request("PUT", "/storage-state", state);
      expect(put.status).toBe(204);

      yield* plain.open(`${site.url}/read`, "read");
      expect(yield* plain.page.evaluate("localStorage.getItem('k')")).toBe("v");
      expect(yield* plain.page.evaluate("localStorage.getItem('unicode')")).toBe('привіт "q"');
      expect(yield* plain.page.evaluate("document.cookie")).toBe("c=1");
      expect(yield* plain.runner.targets).toHaveLength(1);
    }),
  );

  it.effect("what is exported there is what was put in", () =>
    Effect.gen(function* () {
      const { plain } = yield* Stage;
      const again = yield* SessionHttp.exportStorageState(plain.address);
      expect(again.origins).toEqual(state.origins);
      expect(again.cookies).toHaveLength(state.cookies!.length);
    }),
  );

  it.effect("the pages of a session a state with databases is put into find them as made", () =>
    Effect.gen(function* () {
      const { site, withDatabases } = yield* Stage;
      yield* SessionHttp.importStorageState(withDatabases.address, stateWithDatabases);
      yield* withDatabases.open(`${site.url}/read`, "read");

      const found = yield* withDatabases.page.evaluate(READ_DATABASE, Found);
      expect(found).toMatchObject({ version: 3, stores: ["counted", "kept", "loose"] });
      expect(found.indexes).toEqual(["by"]);
      // What JSON does not hold: a date, bytes, a big integer, undefined, a cycle.
      expect(found.rich).toEqual({
        by: "a",
        when: 86400000,
        bytes: [1, 2, 250],
        big: "5",
        none: true,
        cyc: "c",
      });
      expect(found.byIndex).toEqual({ id: 2, by: "b", plain: [1, "two", { three: 3 }] });
      // Records whose keys are not in their values, and a store that counts its own.
      expect(found.token).toBe("abc");
      expect(found.buffer).toEqual([1, 65535]);
      expect(found.counted).toEqual([1]);
    }),
  );

  it.effect("what is exported there is what was put in, databases too", () =>
    Effect.gen(function* () {
      const { withDatabases } = yield* Stage;
      const back = yield* SessionHttp.exportStorageState(withDatabases.address, {
        indexed_db: true,
      });
      expect(back.origins).toEqual(stateWithDatabases.origins);
    }),
  );

  it.effect("a database a tab has open is not replaced under it", () =>
    Effect.gen(function* () {
      const { withDatabases } = yield* Stage;
      const refused = yield* withDatabases.runner.request(
        "PUT",
        "/storage-state",
        stateWithDatabases,
      );
      expect(refused.status).not.toBe(204);
      expect(JSON.stringify(refused.body)).toContain("open in a tab");
    }),
  );

  it.effect("a database holding a file fails the export, which says where the file is", () =>
    Effect.gen(function* () {
      const { source } = yield* Stage;
      yield* source.page.evaluate(STORE_A_FILE);
      yield* until("the file being kept", source.page.evaluate("document.title === 'blob'"));

      const refused = yield* source.runner.request("POST", "/storage-state", { indexed_db: true });
      expect(refused.status).toBe(400);
      const said = JSON.stringify(refused.body);
      expect(said).toContain("files, f");
      expect(said).toContain("Blob");
    }),
  );

  it.effect("and an export without databases still works there", () =>
    Effect.gen(function* () {
      const { site, source } = yield* Stage;
      const without = yield* SessionHttp.exportStorageState(source.address);
      expect(ofSite(without, site)?.localStorage).toEqual(ofSite(state, site)?.localStorage);
    }),
  );
});
