import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { directory } from "./process.ts";
import * as Runner from "./runner.ts";
import { until } from "./wait.ts";

/** What a ticket lets its holder do: an area's name to `r`, `w` or `rw`. */
export type Access = Record<string, "r" | "w" | "rw">;

/** A ticket's claims, where a check wants other than the usual ones. */
export interface Claims {
  readonly sub?: string;
  /** What the others in the session see its holder called; undefined for none. */
  readonly name?: string | undefined;
  readonly sid?: string;
  /** When it runs out, in seconds since the epoch. */
  readonly exp?: number;
}

/** Whoever stands above the session and signs the tickets into it. */
export interface TicketsService {
  /** The session the tickets are for, unless they say another. */
  readonly session: string;
  /** A ticket for Ada that runs out in ten minutes. */
  readonly ticket: (access: Access, claims?: Claims) => string;
}

export class Tickets extends Context.Service<Tickets, TicketsService>()(
  "@aperture-browser/e2e/Tickets",
) {}

const SESSION = "own";
const LASTS_SECONDS = 600;

const encoded = (part: object) => Buffer.from(JSON.stringify(part)).toString("base64url");

/** Seconds since the epoch, `seconds` from now. */
export const fromNow = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

/**
 * A session served on its own that takes tickets, and the signer of them, for all the
 * checks of a suite.
 */
export const layer = (options: Runner.RunnerOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const dir = yield* directory;
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const key = `${dir}/ticket.pem`;
      writeFileSync(key, publicKey.export({ type: "spki", format: "pem" }));

      const ticket: TicketsService["ticket"] = (access, claims = {}) => {
        const payload = {
          sub: "ada",
          name: "Ada",
          sid: SESSION,
          exp: fromNow(LASTS_SECONDS),
          access,
          ...claims,
        };
        const signed = `${encoded({ alg: "EdDSA", typ: "JWT" })}.${encoded(payload)}`;
        const signature = sign(null, Buffer.from(signed), privateKey).toString("base64url");
        return `${signed}.${signature}`;
      };

      const runner = yield* Runner.start({
        ...options,
        args: ["--id", SESSION, "--ticket-key", key, ...(options.args ?? [])],
      });
      return Layer.mergeAll(
        Layer.succeed(Tickets, { session: SESSION, ticket }),
        Layer.succeed(Runner.Runner, runner),
      );
    }),
  );

/** Someone on the session socket, speaking the live protocol as JSON. */
export interface Member {
  /**
   * The last of each kind of message the session sent: `features`, `presence`, `failed`…
   */
  // The live protocol's messages are many shapes; a check reads the ones it knows.
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly seen: Record<string, any>;
  /** Everything the session said it did not do, in order. */
  readonly failures: readonly { readonly asked: string; readonly reason: string }[];
  readonly send: (message: object) => void;
  /** This member as the session's presence tells it, once it does. */
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly self: Effect.Effect<any, Error>;
}

/** Joins a session with a token or a ticket, until the scope ends; waits for a watched tab. */
export const join = (runner: Runner.RunnerService, token: string) =>
  Effect.gen(function* () {
    const seen: Member["seen"] = {};
    const failures: Member["failures"][number][] = [];
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocket(`${runner.url.replace("http", "ws")}/ws?token=${token}`)),
      (opened) => Effect.sync(() => opened.close()),
    );
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ hello: { pixels: "PIXELS_TILES" } })),
    );
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data);
        Object.assign(seen, message);
        if (message.failed !== undefined) {
          failures.push(message.failed);
        }
      }
    });
    yield* until(
      "the session telling which tab is watched",
      Effect.sync(() => seen["selected"] !== undefined),
    );
    return {
      seen,
      failures,
      send: (message) => socket.send(JSON.stringify(message)),
      self: until(
        "presence telling of the member itself",
        Effect.sync(() =>
          seen["presence"]?.members.find(
            (member: { id: unknown }) => member.id === seen["presence"].you,
          ),
        ),
      ),
    } satisfies Member;
  });
