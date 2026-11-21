import { request } from "@aperture-browser/e2e/src/http.ts";
import * as Mcp from "@aperture-browser/e2e/src/mcp.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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

const needs = (stores: (typeof Control.STORES)[number]) =>
  registered.pipe(Layer.provideMerge(Control.layer({ stores })));

/** The server as whoever holds a token of the account that is held to this has it. */
const held = Effect.fn(function* (
  accountId: string,
  payload: {
    readonly scopes: readonly ["sessions:read" | "sessions:write"];
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

for (const stores of Control.STORES) {
  suite(needs(stores))(`the control plane as an MCP server, kept in ${stores}`, (it) => {
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
          ]),
        );
        // No session told what tools it has yet: a session is asked for them itself.
        expect(tools).toEqual(expect.arrayContaining(["sessions.tools", "sessions.call"]));
        expect(tools).not.toContain("navigate");
      }),
    );

    it.effect("a session is created, and what it has for tools is the server's from then on", () =>
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
        const tools = yield* agent.tools;
        expect(tools).toEqual(expect.arrayContaining(["navigate", "snapshot", "tabs", "click"]));
        const own = yield* agent.call("sessions.tools", { session_id: session });
        expect(own).toMatch(/"name":"navigate"/u);
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
          const gone = yield* Effect.flip(
            stranger.call("sessions.delete", { session_id: session }),
          );
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
        expect((yield* ada.api.snapshots.list()).map((one) => one.id)).toEqual([taken.id]);

        yield* agent.call("sessions.delete", { session_id: session });
        expect((yield* Effect.flip(ada.api.sessions.get({ params: { id: session } })))._tag).toBe(
          "SessionNotFound",
        );
      }),
    );
  });
}
