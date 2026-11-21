import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
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
  /** When a session socket opened with it is closed, in seconds since the epoch. */
  readonly until?: number;
}

/** Whoever stands above the session and signs the tickets into it. */
export interface TicketsService {
  /** The session the tickets are for, unless they say another. */
  readonly session: string;
  /** A ticket for Ada that runs out in ten minutes. */
  readonly ticket: (access: Access, claims?: Claims) => Effect.Effect<string>;
}

export class Tickets extends Context.Service<Tickets, TicketsService>()(
  "@aperture-browser/e2e/Tickets",
) {}

const SESSION = "own";
const LASTS_SECONDS = 600;
const PEM_LINE = 64;

const encoded = (part: object) => Base64Url.encode(JSON.stringify(part));

/** Seconds since the epoch, `seconds` from now. */
export const fromNow = (seconds: number) =>
  Clock.currentTimeMillis.pipe(Effect.map((now) => Math.floor(now / 1000) + seconds));

const pem = (key: ArrayBuffer) => {
  const lines = Base64.encode(new Uint8Array(key)).match(new RegExp(`.{1,${PEM_LINE}}`, "gu"));
  return `-----BEGIN PUBLIC KEY-----\n${(lines ?? []).join("\n")}\n-----END PUBLIC KEY-----\n`;
};

/**
 * A session served on its own that takes tickets, and the signer of them, for all the
 * checks of a suite.
 */
export const layer = (options: Runner.RunnerOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* directory;
      // Effect signs nothing: the keys are the platform's own, which makes them or throws.
      const { publicKey, privateKey } = yield* Effect.promise(() =>
        crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
      );
      const key = `${dir}/ticket.pem`;
      yield* fs.writeFileString(
        key,
        pem(yield* Effect.promise(() => crypto.subtle.exportKey("spki", publicKey))),
      );

      const ticket: TicketsService["ticket"] = Effect.fn(function* (access, claims = {}) {
        const payload = {
          sub: "ada",
          name: "Ada",
          sid: SESSION,
          exp: yield* fromNow(LASTS_SECONDS),
          access,
          ...claims,
        };
        const signed = `${encoded({ alg: "EdDSA", typ: "JWT" })}.${encoded(payload)}`;
        const signature = yield* Effect.promise(() =>
          crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(signed)),
        );
        return `${signed}.${Base64Url.encode(new Uint8Array(signature))}`;
      });

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

/** What the session said it did not do. */
export const Failure = Schema.Struct({ asked: Schema.String, reason: Schema.String });
export type Failure = typeof Failure.Type;

/** What the session tells a client its token or ticket grants, area by area. */
export const Features = Schema.Record(
  Schema.String,
  Schema.Struct({
    read: Schema.optional(Schema.Boolean),
    write: Schema.optional(Schema.Boolean),
  }),
);

/** Someone in the session, as its presence tells them. */
export const Present = Schema.Struct({
  id: Schema.Unknown,
  name: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
});
export type Present = typeof Present.Type;

const Presence = Schema.Struct({ you: Schema.Unknown, members: Schema.Array(Present) });

// The live protocol's messages are many shapes; a check reads the ones it knows.
const messageOf = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Someone on the session socket, speaking the live protocol as JSON. */
export interface Member {
  /**
   * The last of each kind of message the session sent: `features`, `presence`, `failed`…
   */
  readonly seen: Readonly<Record<string, unknown>>;
  /** Everything the session said it did not do, in order. */
  readonly failures: readonly Failure[];
  readonly send: (message: object) => Effect.Effect<void, Socket.SocketError>;
  /** This member as the session's presence tells it, once it does. */
  readonly self: Effect.Effect<Present, import("./wait.ts").TimedOut>;
  /** Whether the session socket has ended: closed by the session, or lost. */
  readonly closed: () => boolean;
}

/** Joins a session with a token or a ticket, until the scope ends; waits for a watched tab. */
export const join = Effect.fn("Tickets.join")(function* (
  runner: { readonly url: string },
  token: string,
) {
  let closed = false;
  const seen: Record<string, unknown> = {};
  const failures: Failure[] = [];
  const socket = yield* Socket.makeWebSocket(
    `${runner.url.replace("http", "ws")}/ws?token=${token}`,
  );
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;
  const send: Member["send"] = (message) => writer.write(JSON.stringify(message));

  const heard = Effect.fn(function* (frame: string) {
    const message = yield* messageOf(frame);
    Object.assign(seen, message);
    if (message["failed"] !== undefined) {
      failures.push(yield* Schema.decodeUnknownEffect(Failure)(message["failed"]));
    }
  });
  yield* reader.pull.pipe(
    Effect.flatMap(
      Effect.forEach(
        (frame) => (typeof frame === "string" ? Effect.ignore(heard(frame)) : Effect.void),
        { discard: true },
      ),
    ),
    Effect.forever,
    Effect.ignore,
    Effect.ensuring(
      Effect.sync(() => {
        closed = true;
      }),
    ),
    Effect.forkScoped,
  );
  yield* send({ hello: { pixels: "PIXELS_TILES" } });

  yield* until(
    "the session telling which tab is watched",
    Effect.sync(() => seen["selected"] !== undefined),
  );
  return {
    seen,
    failures,
    send,
    closed: () => closed,
    self: until(
      "presence telling of the member itself",
      Schema.decodeUnknownEffect(Presence)(seen["presence"]).pipe(
        Effect.map((presence) => presence.members.find((member) => member.id === presence.you)),
      ),
    ),
  } satisfies Member;
});
