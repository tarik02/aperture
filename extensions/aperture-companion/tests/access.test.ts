import { browser } from "./chrome-fake.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { requestOrigins } from "../src/chrome.ts";
import { connectionOperation } from "../src/connection-operation.ts";
import { awaitingAccess, cancelPending } from "../src/pending-access.ts";
import { pendingCommand, type PendingCommand } from "../src/pending-command.ts";
import { teleportOperation } from "../src/teleport-operation.ts";

// The step no browser check reaches: the browser's own prompt for the pages' sites, which
// nothing but a person answers. Here it ends each way it can.

const SITE = "https://shop.example/*";
const FRAME = "https://pay.example/*";

/** What asking came to: nothing where the sites were given, what the person is told where not. */
const asked = (origins: readonly string[], accessFor: "teleport" | "connect" = "teleport") =>
  Effect.runPromise(
    requestOrigins(origins, accessFor).pipe(
      Effect.as(undefined),
      Effect.catchTag("CompanionError", (error) => Effect.succeed(error.message)),
    ),
  );

/** A teleport the worker keeps until its sites are given, as the popup that asked left it. */
const waiting = (id: string, origins: readonly string[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pending: PendingCommand = {
        command: {
          type: "teleport-tabs",
          id,
          tabIds: [7],
          activeTabId: 7,
          tags: {},
          destination: "session",
        },
        origins: [...origins],
        createdAt: Date.now(),
      };
      yield* pendingCommand(id).set(pending);
      yield* teleportOperation.set({
        id,
        destination: "session",
        startedAt: pending.createdAt,
        status: "running",
        stage: "requesting-access",
      });
    }),
  );

const told = () =>
  Effect.runPromise(
    Effect.all({
      awaiting: awaitingAccess.pipe(Effect.map((pending) => pending?.command.id ?? null)),
      operation: teleportOperation.get.pipe(Effect.map(Option.getOrNull)),
    }),
  );

beforeEach(() => browser.reset());

describe("asking the browser for the pages' sites", () => {
  it("goes on where they are given", async () => {
    expect(await asked([SITE, FRAME])).toBeUndefined();
  });

  it("says which sites were not given, and that nothing was teleported, where it is refused", async () => {
    browser.prompt = "refuse";
    expect(await asked([SITE, FRAME])).toBe(
      "Access to shop.example, pay.example was not given, so nothing was teleported. Teleport again to be asked once more.",
    );
  });

  it("says the same where the browser puts no prompt up, in words of its own", async () => {
    browser.prompt = "reject";
    const said = await asked([SITE]);
    expect(said).toContain("Access to shop.example was not given");
    expect(said).not.toContain("user gesture");
  });

  it("names the sites that are missing alone, where some were given before", async () => {
    browser.granted.add(SITE);
    browser.prompt = "refuse";
    expect(await asked([SITE, FRAME])).toContain("Access to pay.example was not given");
  });

  it("goes on where the sites are had though the prompt said no", async () => {
    browser.granted.add(SITE);
    browser.prompt = "refuse";
    expect(await asked([SITE])).toBeUndefined();
  });

  it("says of a connection that nothing was connected", async () => {
    browser.prompt = "refuse";
    expect(await asked(["https://aperture.example/*"], "connect")).toBe(
      "Access to aperture.example was not given, so nothing was connected. Connect again to be asked once more.",
    );
  });
});

describe("a command that waits in the worker for its sites", () => {
  it("is found by the popup that opens next, while the sites are not given", async () => {
    await waiting("t1", [SITE, FRAME]);
    expect((await told()).awaiting).toBe("t1");
    // Some of them is not all of them.
    browser.granted.add(SITE);
    expect((await told()).awaiting).toBe("t1");
  });

  it("is nothing to ask about once they are given: the worker goes on with it", async () => {
    await waiting("t1", [SITE]);
    browser.granted.add(SITE);
    expect((await told()).awaiting).toBeNull();
  });

  it("is taken back with what told of it as in progress, when the person cancels", async () => {
    await waiting("t1", [SITE]);
    const taken = await Effect.runPromise(cancelPending("t1"));
    expect(taken?.command.id).toBe("t1");
    expect(await told()).toEqual({ awaiting: null, operation: null });
    expect(browser.session.kept.size).toBe(0);
    // Taking back what is gone is taking back nothing.
    expect(await Effect.runPromise(cancelPending("t1"))).toBeNull();
  });

  it("leaves what another command told of itself", async () => {
    await waiting("t1", [SITE]);
    await Effect.runPromise(
      teleportOperation.set({
        id: "t2",
        destination: "session",
        startedAt: Date.now(),
        status: "running",
        stage: "capturing",
      }),
    );
    await Effect.runPromise(cancelPending("t1"));
    expect((await told()).operation?.id).toBe("t2");
  });

  it("is not taken back once it made a session", async () => {
    await waiting("t1", [SITE]);
    await Effect.runPromise(
      pendingCommand("t1").get.pipe(
        Effect.flatMap((pending) =>
          pendingCommand("t1").set({
            ...Option.getOrThrow(pending),
            teleport: { connectionId: "c", warnings: [], stage: "opening", sessionId: "s" },
          }),
        ),
      ),
    );
    // Its sites were given, or it would not be under way: taking them away changes nothing.
    expect((await told()).awaiting).toBeNull();
    const refused = await Effect.runPromise(Effect.flip(cancelPending("t1")));
    expect(refused.message).toBe("The teleport is under way already");
    expect((await told()).operation?.status).toBe("running");
  });

  it("is a connection's as well, which is taken back with its own progress", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* pendingCommand("c1").set({
          command: { type: "connect-oauth", id: "c1", origin: "https://aperture.example" },
          origins: ["https://aperture.example/*"],
          createdAt: Date.now(),
        });
        yield* connectionOperation.set({
          id: "c1",
          method: "oauth",
          startedAt: Date.now(),
          status: "running",
        });
      }),
    );
    expect((await told()).awaiting).toBe("c1");
    await Effect.runPromise(cancelPending("c1"));
    expect(Option.isNone(await Effect.runPromise(connectionOperation.get))).toBe(true);
  });
});

describe("a popup that is told the sites were not given", () => {
  it("asks once, and leaves nothing waiting", async () => {
    await waiting("t1", [SITE]);
    browser.prompt = "refuse";
    // As the popup does it: ask, and have the command taken back where that fails.
    const said = await Effect.runPromise(
      requestOrigins([SITE], "teleport").pipe(
        Effect.tapError(() => cancelPending("t1")),
        Effect.as(undefined),
        Effect.catchTag("CompanionError", (error) => Effect.succeed(error.message)),
      ),
    );
    expect(said).toContain("nothing was teleported");
    expect(browser.asked).toBe(1);
    expect(await told()).toEqual({ awaiting: null, operation: null });
  });

  it("goes on where asking again is answered with the sites", async () => {
    await waiting("t1", [SITE]);
    expect((await told()).awaiting).toBe("t1");
    expect(await asked([SITE])).toBeUndefined();
    // The command stays for the worker, which runs it; the popup has nothing left to offer.
    expect((await told()).awaiting).toBeNull();
    expect(browser.session.kept.size).toBe(2);
  });
});
