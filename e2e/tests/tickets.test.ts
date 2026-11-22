import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { HttpMethod } from "effect/http/HttpMethod";
import * as Schema from "effect/Schema";
import { request } from "../src/http.ts";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";
import * as Tickets from "../src/tickets.ts";
import { happens, until } from "../src/wait.ts";

const session = Tickets.layer({
  features: ["sound", "uploads", "downloads", "recordings", "clipboard", "mcp", "cdp", "tunnel"],
});

/** A request and the status it is to be answered with. */
type Answered = readonly [method: HttpMethod, path: string, status: number, body?: unknown];

/** Asks each with the token, and expects each answered as said. */
const answers = (token: string, all: readonly Answered[]) =>
  Effect.gen(function* () {
    const runner = yield* Runner.Runner;
    for (const [method, path, status, body] of all) {
      const answer = yield* request(runner.url, token, method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(status);
    }
  });

/** Asks for a new tab, as the workbench's button does. */
const newTab = { go: { url: "", newTab: true } };

suite(session)("tickets into a session served on its own", (it) => {
  it.effect("a ticket with no access watches, and does nothing else", () =>
    Effect.gen(function* () {
      const tickets = yield* Tickets.Tickets;
      yield* answers(yield* tickets.ticket({}), [
        ["GET", "/targets", 200],
        ["GET", "/targets/1/preview.png", 200],
        ["PUT", "/targets/1/mode", 403, { mode: "mobile" }],
        ["GET", "/", 200],
        ["GET", "/recordings", 403],
        ["POST", "/screenshots", 403],
        ["GET", "/uploads", 403],
        ["PUT", "/uploads/a.txt", 403, "x"],
        ["GET", "/downloads", 403],
        ["PUT", "/proxy", 403, {}],
        ["POST", "/mcp", 403, {}],
        ["GET", "/cdp/json/version", 403],
        ["GET", "/files/recordings/x", 403],
        ["GET", "/files/anything", 403],
      ]);
    }),
  );

  it.effect("a ticket that reads an area lists what is there, and changes nothing", () =>
    Effect.gen(function* () {
      const tickets = yield* Tickets.Tickets;
      const reader = yield* tickets.ticket({ recordings: "r", uploads: "r", downloads: "r" });
      yield* answers(reader, [
        ["GET", "/recordings", 200],
        ["GET", "/screenshots", 200],
        ["POST", "/screenshots", 403],
        ["POST", "/recordings", 403, {}],
        ["GET", "/uploads", 200],
        ["PUT", "/uploads/a.txt", 403, "x"],
        ["GET", "/downloads", 200],
      ]);
    }),
  );

  it.effect("a ticket that writes an area changes it, and reads it only if it says so", () =>
    Effect.gen(function* () {
      const tickets = yield* Tickets.Tickets;
      const writer = yield* tickets.ticket({ recordings: "rw", uploads: "w", cdp: "w", mcp: "w" });
      yield* answers(writer, [
        ["POST", "/screenshots", 201],
        ["PUT", "/uploads/a.txt", 200, "x"],
        ["GET", "/uploads", 403],
        ["DELETE", "/uploads/a.txt", 204],
        ["GET", "/cdp/json/version", 200],
        ["PUT", "/proxy", 403, {}],
      ]);
    }),
  );

  it.effect("a ticket for another session is refused", () =>
    Effect.gen(function* () {
      const tickets = yield* Tickets.Tickets;
      const elsewhere = yield* tickets.ticket({ recordings: "rw" }, { sid: "other" });
      yield* answers(elsewhere, [["GET", "/targets", 403]]);
    }),
  );

  it.effect("a ticket that ran out is refused", () =>
    Effect.gen(function* () {
      const tickets = yield* Tickets.Tickets;
      const ranOut = yield* tickets.ticket({}, { exp: yield* Tickets.fromNow(-600) });
      yield* answers(ranOut, [["GET", "/targets", 401]]);
    }),
  );

  it.effect("the operator's token does anything", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      yield* answers(runner.token, [
        ["GET", "/recordings", 200],
        ["GET", "/uploads", 200],
      ]);
    }),
  );

  it.effect("the session socket tells a client what its ticket grants", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const tickets = yield* Tickets.Tickets;
      const ticket = yield* tickets.ticket({ sound: "r", tabs: "w", input: "w" });
      const member = yield* Tickets.join(runner, ticket);

      const features = yield* Schema.decodeUnknownEffect(Tickets.Features)(member.seen["features"]);
      expect(features.sound?.read).toBe(true);
      expect(features.tabs?.write).toBe(true);
      expect(features.input?.write).toBe(true);
      expect(features.clipboard?.read ?? false).toBe(false);
      expect(features.recordings?.write ?? false).toBe(false);
      expect(features.lease?.write ?? false).toBe(false);
    }),
  );

  it.effect("a member is called what its ticket says, and by its subject without a name", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const tickets = yield* Tickets.Tickets;

      const named = yield* Tickets.join(runner, yield* tickets.ticket({}));
      expect((yield* named.self).name).toBe("Ada");

      const unnamed = yield* Tickets.join(runner, yield* tickets.ticket({}, { name: undefined }));
      expect((yield* unnamed.self).name).toBe("ada");
    }),
  );

  it.effect("what a ticket grants is the role its holder has among the members", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const tickets = yield* Tickets.Tickets;
      const roleWith = (access: Tickets.Access) =>
        tickets.ticket(access).pipe(
          Effect.flatMap((ticket) => Tickets.join(runner, ticket)),
          Effect.flatMap((member) => member.self),
          Effect.map((self) => self.role),
        );

      expect(yield* roleWith({})).toBe("ROLE_VIEW");
      expect(yield* roleWith({ sound: "r", tabs: "w", input: "w" })).toBe("ROLE_CONTROL");
      expect(yield* roleWith({ input: "w", lease: "w" })).toBe("ROLE_ADMIN");
    }),
  );

  it.effect("whoever the operator dismisses is put out of the session, and nobody else", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const tickets = yield* Tickets.Tickets;
      const guest = yield* Tickets.join(runner, yield* tickets.ticket({}, { sub: "share:one" }));
      const other = yield* Tickets.join(runner, yield* tickets.ticket({}, { sub: "share:two" }));

      // It is the operator's to ask, and no ticket's.
      yield* answers(yield* tickets.ticket({ input: "rw", lease: "rw" }), [
        ["DELETE", "/callers/share%3Aone", 403],
      ]);
      expect(guest.closed()).toBe(false);
      yield* answers(runner.token, [["DELETE", "/callers/share%3Aone", 204]]);
      yield* until(
        "the dismissed one's socket ending",
        Effect.sync(() => guest.closed()),
      );
      expect(
        yield* happens(
          Effect.sync(() => other.closed()),
          "1 second",
        ),
      ).toBe(false);
    }),
  );

  it.effect("a socket ends when its ticket says what let its holder in does", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const tickets = yield* Tickets.Tickets;
      const brief = yield* Tickets.join(
        runner,
        yield* tickets.ticket({}, { until: yield* Tickets.fromNow(2) }),
      );
      const staying = yield* Tickets.join(runner, yield* tickets.ticket({}));
      expect(brief.closed()).toBe(false);
      yield* until(
        "the socket ending when its ticket said",
        Effect.sync(() => brief.closed()),
        "10 seconds",
      );
      expect(staying.closed()).toBe(false);
    }),
  );

  it.effect("with tabs:w a new tab opens, and what was done is not answered", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const tickets = yield* Tickets.Tickets;
      const member = yield* Tickets.join(runner, yield* tickets.ticket({ tabs: "w", input: "w" }));
      const before = (yield* runner.targets).length;

      yield* member.send(newTab);
      const opened = yield* happens(
        runner.targets.pipe(Effect.map((targets) => targets.length === before + 1)),
      );
      expect(opened).toBe(true);
      expect(member.failures).toEqual([]);
    }),
  );

  it.effect("a page that is not on the web is answered as failed", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const tickets = yield* Tickets.Tickets;
      const member = yield* Tickets.join(runner, yield* tickets.ticket({ tabs: "w", input: "w" }));

      yield* member.send({ go: { url: "about:blank" } });
      const failure = yield* until(
        "the session answering",
        Effect.sync(() => member.failures[0]),
      );
      expect(failure.asked).toBe("ASKED_GO");
      expect(failure.reason).not.toBe("");
    }),
  );

  it.effect("files chosen without uploads:w are answered as failed", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const tickets = yield* Tickets.Tickets;
      const member = yield* Tickets.join(runner, yield* tickets.ticket({ tabs: "w", input: "w" }));

      yield* member.send({ filesChosen: { id: 1, files: ["nothing.txt"] } });
      const failure = yield* until(
        "the session answering",
        Effect.sync(() => member.failures[0]),
      );
      expect(failure.asked).toBe("ASKED_FILES_CHOSEN");
      expect(failure.reason).not.toBe("");
    }),
  );

  it.effect("without tabs:w no tab opens, and the client is told so", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const tickets = yield* Tickets.Tickets;
      const member = yield* Tickets.join(runner, yield* tickets.ticket({ input: "w" }));
      const before = (yield* runner.targets).length;

      yield* member.send(newTab);
      const failure = yield* until(
        "the session answering",
        Effect.sync(() => member.failures[0]),
      );
      expect(failure.asked).toBe("ASKED_GO");
      expect(failure.reason).not.toBe("");
      expect((yield* runner.targets).length).toBe(before);
    }),
  );
});
