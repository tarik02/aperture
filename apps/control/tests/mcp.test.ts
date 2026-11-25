import { Executor } from "@aperture-browser/e2e/src/executor.ts";
import { follow, request } from "@aperture-browser/e2e/src/http.ts";
import * as Mcp from "@aperture-browser/e2e/src/mcp.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import type { Scope } from "@aperture-browser/control-api";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Control from "./src/control.ts";
import { registered } from "./src/node.ts";

const PAGE = "data:text/html,<title>agent tab</title><h1>opened by the agent</h1>";

const Told = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, observedState: Schema.String }),
);
const Listed = Schema.fromJsonString(
  Schema.Struct({ sessions: Schema.Array(Schema.Struct({ id: Schema.String })) }),
);
const Opened = Schema.fromJsonString(Schema.Struct({ tab: Schema.Number }));
/** Who is in a session, as it tells whoever watches it. */
const Present = Schema.fromJsonString(
  Schema.Struct({
    presence: Schema.Struct({
      members: Schema.Array(
        Schema.Struct({
          name: Schema.optional(Schema.String),
          agent: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  }),
);

/** An address a file is fetched from or put to. */
const Link = Schema.fromJsonString(
  Schema.Struct({ url: Schema.String, method: Schema.String, expiresAt: Schema.String }),
);
const Files = Schema.fromJsonString(
  Schema.Struct({
    files: Schema.Array(
      Schema.Struct({ path: Schema.String, size: Schema.Number, absolute: Schema.String }),
    ),
  }),
);
const Ticket = Schema.fromJsonString(
  Schema.Struct({ url: Schema.String, ticket: Schema.String, expires_at: Schema.String }),
);
const Shared = Schema.fromJsonString(Schema.Struct({ id: Schema.String, url: Schema.String }));
const Made = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));

const needs = registered.pipe(Layer.provideMerge(Control.layer()));

/** The server as whoever holds a token of the account that is held to this has it. */
const held = Effect.fn(function* (
  accountId: string,
  payload: {
    readonly scopes: readonly [Scope, ...Scope[]];
    readonly resources?: {
      readonly workspaces: readonly string[];
      readonly sessions: readonly string[];
      readonly snapshots: readonly string[];
    };
  },
) {
  const control = yield* Control.Control;
  const bootstrap = yield* control.as(control.bootstrapToken);
  const made = yield* bootstrap.accounts.createToken({
    params: { id: accountId },
    payload: { name: "held", ...payload },
  });
  return yield* Mcp.connect(control.url, made.token);
});

suite(needs)("the control plane as an MCP server", (it) => {
  let ada: Effect.Success<ReturnType<typeof Control.account>>;
  let agent: Mcp.Mcp;
  let session = "";
  let tab = 0;

  it.effect("nobody is let in without a token, and a token's holder is told the tools", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const nobody = yield* request(control.url, "nobody's", "POST", "/mcp", {});
      expect(nobody.status).toBe(401);

      ada = yield* Control.account("Ada");
      agent = yield* Mcp.connect(control.url, ada.token);
      const tools = yield* agent.tools;
      expect(tools).toEqual(
        expect.arrayContaining([
          "sessions.list",
          "sessions.get",
          "sessions.create",
          "sessions.update",
          "sessions.suspend",
          "sessions.resume",
          "sessions.delete",
          "sessions.promote",
          "snapshots.list",
          "snapshots.update",
          "snapshots.delete",
          "sessions.proxy",
          "sessions.set_proxy",
          "sessions.ticket",
          "sessions.file_link",
          "shares.list",
          "shares.create",
          "shares.revoke",
          "workspaces.list",
          "workspaces.members",
          "workspaces.create",
          "workspaces.rename",
          "workspaces.delete",
          "workspaces.admit",
          "workspaces.dismiss",
          "account.get",
          "events.list",
        ]),
      );
      expect(tools).toEqual(expect.arrayContaining(["sessions.tools", "sessions.call"]));
      // No session runs: what one has is listed all the same, for the session it names.
      const listed = yield* agent.listed;
      for (const name of ["navigate", "snapshot", "tabs", "click", "files"]) {
        expect(listed.find((tool) => tool.name === name)?.required, name).toContain("session_id");
      }
    }),
  );

  it.effect("a session is created, and has the tools that were listed", () =>
    Effect.gen(function* () {
      const created = yield* agent
        .call("sessions.create", { label: "an agent's", tags: { made: "over mcp" } })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Told)));
      session = created.id;
      expect((yield* ada.api.sessions.get({ params: { id: session } })).label).toBe("an agent's");

      yield* until(
        "the session running",
        agent.call("sessions.get", { session_id: session }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Told)),
          Effect.map((told) => told.observedState === "running"),
        ),
        "60 seconds",
      );
      const own = yield* agent
        .call("sessions.tools", { session_id: session })
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String }))),
            ),
          ),
        );
      expect(own.map((tool) => tool.name)).toContain("navigate");
      // What the server lists of a session's tools is what a session of its version has.
      const tools = yield* agent.tools;
      expect(tools).toEqual(expect.arrayContaining(own.map((tool) => tool.name)));
    }),
  );

  it.effect("a page is opened and read in the session through the server", () =>
    Effect.gen(function* () {
      const opened = yield* agent
        .call("navigate", { session_id: session, url: PAGE })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Opened)));
      tab = opened.tab;
      const read = yield* agent.call("snapshot", { session_id: session, tab });
      expect(read).toMatch(/opened by the agent/u);
      // A tool of the session is also called by its name, as before any was listed.
      const tabs = yield* agent.call("sessions.call", { session_id: session, name: "tabs" });
      expect(tabs).toMatch(/agent tab/u);

      const refused = yield* Effect.flip(agent.call("navigate", { url: PAGE }));
      expect(refused.reason).toMatch(/session_id/u);
    }),
  );

  it.effect("whoever's token calls is in the session under the account's name", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const socket = yield* Socket.makeWebSocket(
        `${executor.url.replace("http", "ws")}/sessions/${session}/ws?token=${executor.token}`,
      );
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      let automation: ReadonlyArray<string | undefined> = [];
      yield* reader.pull.pipe(
        Effect.flatMap(
          Effect.forEach(
            (frame) =>
              typeof frame === "string"
                ? Schema.decodeUnknownEffect(Present)(frame).pipe(
                    Effect.map(({ presence }) => {
                      automation = presence.members
                        .filter((member) => member.agent === true)
                        .map((member) => member.name);
                    }),
                    Effect.ignore,
                  )
                : Effect.void,
            { discard: true },
          ),
        ),
        Effect.forever,
        Effect.ignore,
        Effect.forkScoped,
      );
      yield* writer.write(JSON.stringify({ hello: { pixels: "PIXELS_TILES" } }));

      yield* agent.call("tabs", { session_id: session });
      yield* until(
        "the account's automation being in the session",
        Effect.sync(() => automation.includes("Ada")),
      );
    }),
  );

  it.effect("a token that only reads sessions is refused what changes them", () =>
    Effect.gen(function* () {
      const reader = yield* held(ada.account.id, { scopes: ["sessions:read"] });
      const seen = yield* reader
        .call("sessions.get", { session_id: session })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Told)));
      expect(seen.id).toBe(session);

      for (const [tool, args] of [
        ["sessions.create", {}],
        ["sessions.update", { session_id: session, label: "theirs" }],
        ["sessions.suspend", { session_id: session }],
        ["navigate", { session_id: session, url: PAGE }],
        ["sessions.call", { session_id: session, name: "tabs" }],
      ] as const) {
        const refused = yield* Effect.flip(reader.call(tool, args));
        expect(refused.reason, tool).toMatch(/not for sessions:write/u);
      }
      const refused = yield* Effect.flip(reader.call("snapshots.list", {}));
      expect(refused.reason).toMatch(/not for snapshots:read/u);
      expect((yield* ada.api.sessions.get({ params: { id: session } })).label).toBe("an agent's");
    }),
  );

  it.effect("a token held to another session does not reach this one, nor another account", () =>
    Effect.gen(function* () {
      const other = yield* ada.api.sessions.create({ payload: { suspended: true } });
      const bound = yield* held(ada.account.id, {
        scopes: ["sessions:write"],
        resources: { workspaces: [], sessions: [other.id], snapshots: [] },
      });
      const listed = yield* bound
        .call("sessions.list", {})
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Listed)));
      expect(listed.sessions.map((one) => one.id)).toEqual([other.id]);

      const eve = yield* Control.account("Eve");
      const control = yield* Control.Control;
      for (const stranger of [bound, yield* Mcp.connect(control.url, eve.token)]) {
        const got = yield* Effect.flip(stranger.call("sessions.get", { session_id: session }));
        expect(got.reason).toMatch(/SessionNotFound/u);
        const gone = yield* Effect.flip(stranger.call("sessions.delete", { session_id: session }));
        expect(gone.reason).toMatch(/SessionNotFound/u);
        const driven = yield* Effect.flip(
          stranger.call("navigate", { session_id: session, url: PAGE }),
        );
        expect(driven.reason).toMatch(/there is no session/u);
      }
      const still = yield* agent.call("snapshot", { session_id: session, tab });
      expect(still).toMatch(/opened by the agent/u);
    }),
  );

  it.effect("a file is put into the session and fetched from it at addresses a tool makes", () =>
    Effect.gen(function* () {
      const said = new TextEncoder().encode("given to the agent's session");
      const put = yield* agent
        .call("sessions.file_link", {
          session_id: session,
          path: "uploads/brief.txt",
          write: true,
        })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Link)));
      expect(put.method).toBe("PUT");
      expect((yield* follow(put.url, "PUT", said)).status).toBe(200);

      // The session's own tool tells what there is, and where a page's tool finds it.
      const files = yield* agent
        .call("files", { session_id: session, directory: "uploads" })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Files)));
      expect(files.files).toMatchObject([{ path: "uploads/brief.txt", size: said.length }]);
      expect(files.files[0]?.absolute).toMatch(/\/uploads\/brief\.txt$/u);

      const got = yield* agent
        .call("sessions.file_link", { session_id: session, path: "uploads/brief.txt" })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Link)));
      expect(got.method).toBe("GET");
      const read = yield* follow(got.url);
      expect(new TextDecoder().decode(read.bytes)).toBe("given to the agent's session");

      // A screenshot the session keeps is a file as well.
      yield* agent.call("screenshot", { session_id: session, tab });
      const all = yield* agent
        .call("files", { session_id: session })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Files)));
      expect(all.files.map((file) => file.path)).toContain("uploads/brief.txt");

      const removed = yield* agent.call("files", {
        session_id: session,
        action: "delete",
        path: "uploads/brief.txt",
      });
      expect(removed).toMatch(/"deleted":"uploads\/brief.txt"/u);
      expect((yield* follow(got.url)).status).toBe(404);
      const other = yield* Effect.flip(
        agent.call("files", { session_id: session, action: "delete", path: "recordings/x.mkv" }),
      );
      expect(other.reason).toMatch(/only an upload/u);

      const badly = yield* Effect.flip(
        agent.call("sessions.file_link", { session_id: session, path: "../token" }),
      );
      expect(badly.reason).not.toBe("");
      const elsewhere = yield* Effect.flip(
        agent.call("sessions.file_link", {
          session_id: session,
          path: "downloads/made-up.bin",
          write: true,
        }),
      );
      expect(elsewhere.reason).toMatch(/put at uploads/u);
    }),
  );

  it.effect("a person is handed the session by a ticket, and a guest by a share link", () =>
    Effect.gen(function* () {
      const executor = yield* Executor;
      const handed = yield* agent
        .call("sessions.ticket", {
          session_id: session,
          name: "Ada herself",
          access: { input: "rw", tabs: "rw" },
        })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ticket)));
      expect(handed.url).toBe(`${executor.url}/sessions/${session}/?token=${handed.ticket}`);
      expect(Date.parse(handed.expires_at)).toBeGreaterThan(Date.now());
      const targets = `/sessions/${session}/targets`;
      expect((yield* request(executor.url, handed.ticket, "GET", targets)).status).toBe(200);
      // What the ticket was not given is not its holder's.
      const proxy = `/sessions/${session}/proxy`;
      expect((yield* request(executor.url, handed.ticket, "PUT", proxy, {})).status).toBe(403);

      const link = yield* agent
        .call("shares.create", {
          session_id: session,
          name: "for the client",
          role: "watch",
          expires_in_hours: 1,
        })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Shared)));
      expect(link.url).toMatch(new RegExp(`/share/${link.id}#aps_`, "u"));
      const listed = yield* agent.call("shares.list", { session_id: session });
      expect(listed).toContain(link.id);
      // The secret is told once, where the link is made.
      expect(listed).not.toContain("aps_");
      yield* agent.call("shares.revoke", { session_id: session, share_id: link.id });
      expect(yield* ada.api.shares.list({ params: { id: session } })).toEqual([]);
      const gone = yield* Effect.flip(
        agent.call("shares.revoke", { session_id: session, share_id: link.id }),
      );
      expect(gone.reason).toMatch(/ShareNotFound/u);
    }),
  );

  it.effect("the session's routing is read and set", () =>
    Effect.gen(function* () {
      expect(yield* agent.call("sessions.proxy", { session_id: session })).toBe('{"proxy":null}');
      const proxy = { rules: [{ match: "blocked.example", via: "refuse" }] };
      yield* agent.call("sessions.set_proxy", { session_id: session, proxy });
      expect((yield* ada.api.sessions.proxy({ params: { id: session } })).proxy).toEqual(proxy);
      expect(JSON.parse(yield* agent.call("sessions.proxy", { session_id: session }))).toEqual({
        proxy,
      });
      yield* agent.call("sessions.set_proxy", { session_id: session, proxy: null });
      expect((yield* ada.api.sessions.proxy({ params: { id: session } })).proxy).toBeNull();
    }),
  );

  it.effect("a token is refused by a tool what the same call of the API refuses it", () =>
    Effect.gen(function* () {
      const reader = yield* held(ada.account.id, { scopes: ["sessions:read"] });
      // Reading what a session is, who has links into it, and watching it are a reader's.
      yield* reader.call("sessions.proxy", { session_id: session });
      yield* reader.call("shares.list", { session_id: session });
      const watching = yield* reader
        .call("sessions.ticket", { session_id: session })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ticket)));
      expect(watching.url).toContain(watching.ticket);
      const told = yield* reader.call("account.get", {});
      expect(JSON.parse(told)).toMatchObject({ id: ada.account.id, scopes: ["sessions:read"] });
      expect(yield* reader.call("workspaces.list", {})).toBe('{"workspaces":[]}');

      for (const [tool, args, scope] of [
        ["sessions.ticket", { session_id: session, access: { input: "rw" } }, "sessions:write"],
        ["sessions.file_link", { session_id: session, path: "uploads/a.txt" }, "sessions:write"],
        ["sessions.set_proxy", { session_id: session, proxy: null }, "sessions:write"],
        [
          "shares.create",
          { session_id: session, name: "theirs", role: "control" },
          "sessions:write",
        ],
        ["shares.revoke", { session_id: session, share_id: "any" }, "sessions:write"],
        ["files", { session_id: session }, "sessions:write"],
        ["workspaces.create", { name: "theirs" }, "workspaces:write"],
        ["workspaces.members", { workspace_id: "any" }, "workspaces:read"],
        [
          "workspaces.admit",
          { workspace_id: "any", account_id: "any", role: "admin" },
          "workspaces:write",
        ],
        ["workspaces.dismiss", { workspace_id: "any", account_id: "any" }, "workspaces:write"],
        ["workspaces.rename", { workspace_id: "any", name: "theirs" }, "workspaces:write"],
        ["workspaces.delete", { workspace_id: "any" }, "workspaces:write"],
        ["events.list", {}, "events:read"],
      ] as const) {
        const refused = yield* Effect.flip(reader.call(tool, args));
        expect(refused.reason, tool).toMatch(new RegExp(`not for ${scope}`, "u"));
      }
      // Making sessions is not reading snapshots: none is made of one.
      const maker = yield* held(ada.account.id, { scopes: ["sessions:write"] });
      const unread = yield* Effect.flip(maker.call("sessions.create", { snapshot_id: "any" }));
      expect(unread.reason).toMatch(/not for snapshots:read/u);
      expect(yield* ada.api.shares.list({ params: { id: session } })).toEqual([]);
    }),
  );

  it.effect(
    "a workspace is made and a service account let into it, which reaches what is its",
    () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const bootstrap = yield* control.as(control.bootstrapToken);
        const team = yield* agent
          .call("workspaces.create", { name: "Crawlers" })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Made)));
        const shared = yield* agent
          .call("sessions.create", { workspace_id: team.id, label: "the team's" })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Told)));
        const listed = (asked: object) =>
          agent.call("sessions.list", asked).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Listed)),
            Effect.map((told) => told.sessions.map((one) => one.id)),
          );
        expect(yield* listed({ workspace_id: team.id })).toEqual([shared.id]);
        const own = yield* listed({ workspace_id: "none" });
        expect(own).toContain(session);
        expect(own).not.toContain(shared.id);
        expect(yield* listed({ label: "TEAM" })).toEqual([shared.id]);
        expect(yield* listed({ tag: "made=over mcp" })).toEqual([session]);

        // A service account comes with tokens alone, and is let in by its id.
        const bot = yield* bootstrap.accounts.create({
          payload: { name: "Crawler", kind: "service" },
        });
        const asBot = yield* held(bot.id, {
          scopes: ["sessions:write", "workspaces:read", "events:read"],
        });
        expect(yield* asBot.call("sessions.list", {})).toBe('{"sessions":[]}');
        const outside = yield* Effect.flip(
          asBot.call("workspaces.members", { workspace_id: team.id }),
        );
        expect(outside.reason).toMatch(/WorkspaceNotFound/u);
        const notTheirs = yield* Effect.flip(
          asBot.call("sessions.file_link", { session_id: shared.id, path: "uploads/a.txt" }),
        );
        expect(notTheirs.reason).toMatch(/SessionNotFound/u);

        yield* agent.call("workspaces.admit", {
          workspace_id: team.id,
          account_id: bot.id,
          role: "member",
        });
        expect(yield* asBot.call("workspaces.list", {})).toMatch(
          /"name":"Crawlers".*"role":"member"/u,
        );
        const members = yield* asBot.call("workspaces.members", { workspace_id: team.id });
        expect(members).toMatch(/"name":"Crawler".*"kind":"service"/u);
        const theirs = yield* asBot
          .call("sessions.list", {})
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Listed)));
        // The workspace's session, and not the one that is Ada's own.
        expect(theirs.sessions.map((one) => one.id)).toEqual([shared.id]);
        yield* asBot.call("sessions.ticket", { session_id: shared.id });
        const adas = yield* Effect.flip(asBot.call("sessions.ticket", { session_id: session }));
        expect(adas.reason).toMatch(/SessionNotFound/u);
        // A member is no admin of the workspace, whatever their token is for.
        const asBotWriting = yield* held(bot.id, { scopes: ["workspaces:write"] });
        for (const [tool, args] of [
          ["workspaces.rename", { workspace_id: team.id, name: "Theirs" }],
          ["workspaces.admit", { workspace_id: team.id, account_id: bot.id, role: "admin" }],
          ["workspaces.dismiss", { workspace_id: team.id, account_id: ada.account.id }],
          ["workspaces.delete", { workspace_id: team.id }],
        ] as const) {
          const refused = yield* Effect.flip(asBotWriting.call(tool, args));
          expect(refused.reason, tool).toMatch(/admin of the workspace/u);
        }
        // What was done in the workspace is told to its members, and to nobody outside it.
        const events = yield* asBot.call("events.list", { resource_id: shared.id });
        expect(events).toMatch(/"kind":"session.created"/u);
        const eve = yield* Control.account("Eve of no workspace");
        const stranger = yield* Mcp.connect(control.url, eve.token);
        expect(yield* stranger.call("events.list", { resource_id: shared.id })).toBe(
          '{"events":[],"next":null}',
        );
        expect(yield* stranger.call("workspaces.list", {})).toBe('{"workspaces":[]}');

        // A token held to another workspace is told of neither this one nor who is in it.
        const elsewhere = yield* held(ada.account.id, {
          scopes: ["sessions:write", "workspaces:write"],
          resources: { workspaces: ["another-workspace"], sessions: [], snapshots: [] },
        });
        expect(yield* elsewhere.call("workspaces.list", {})).toBe('{"workspaces":[]}');
        const hidden = yield* Effect.flip(
          elsewhere.call("workspaces.members", { workspace_id: team.id }),
        );
        expect(hidden.reason).toMatch(/WorkspaceNotFound/u);
        const unreached = yield* Effect.flip(
          elsewhere.call("sessions.ticket", { session_id: shared.id }),
        );
        expect(unreached.reason).toMatch(/SessionNotFound/u);

        yield* agent.call("workspaces.dismiss", { workspace_id: team.id, account_id: bot.id });
        expect(yield* asBot.call("sessions.list", {})).toBe('{"sessions":[]}');
        const inUse = yield* Effect.flip(
          agent.call("workspaces.delete", { workspace_id: team.id }),
        );
        expect(inUse.reason).toMatch(/WorkspaceInUse/u);
        yield* agent.call("sessions.delete", { session_id: shared.id });
        const renamed = yield* agent.call("workspaces.rename", {
          workspace_id: team.id,
          name: "Spiders",
        });
        expect(renamed).toMatch(/"name":"Spiders"/u);
        yield* agent.call("workspaces.delete", { workspace_id: team.id });
        expect(yield* agent.call("workspaces.list", {})).toBe('{"workspaces":[]}');
      }),
  );

  it.effect("a snapshot is taken of the session, and the session deleted", () =>
    Effect.gen(function* () {
      const taken = yield* agent
        .call("sessions.promote", { session_id: session, name: "signed in" })
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Struct({ id: Schema.String, name: Schema.String })),
            ),
          ),
        );
      expect(taken.name).toBe("signed in");
      expect((yield* ada.api.snapshots.list({ query: {} })).map((one) => one.id)).toEqual([
        taken.id,
      ]);

      yield* agent.call("sessions.delete", { session_id: session });
      expect((yield* Effect.flip(ada.api.sessions.get({ params: { id: session } })))._tag).toBe(
        "SessionNotFound",
      );
    }),
  );
});
