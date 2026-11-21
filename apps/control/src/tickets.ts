import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { TicketKeyUnusable } from "./errors.ts";
import { Settings } from "./settings.ts";

/** The areas of a session a ticket gives access to, each read, written or both. */
export const Access = Schema.Record(
  Schema.Literals([
    "input",
    "tabs",
    "lease",
    "sound",
    "clipboard",
    "uploads",
    "downloads",
    "recordings",
    "proxy",
    "mcp",
    "cdp",
    "tunnel",
  ]),
  Schema.optional(Schema.Literals(["r", "w", "rw"])),
);
export type Access = typeof Access.Type;

export interface Issued {
  readonly ticket: string;
  readonly expiresAt: DateTime.Utc;
}

const PEM = /-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----/u;

const encoded = (part: object) => Base64Url.encode(JSON.stringify(part));

export class Tickets extends Context.Service<
  Tickets,
  {
    /** Signs a ticket for one person into one session, good for as long as tickets are. */
    readonly issue: (ticket: {
      readonly sessionId: string;
      readonly subject: string;
      readonly name: string;
      readonly access: Access;
    }) => Effect.Effect<Issued>;
  }
>()("@aperture-browser/control/Tickets") {
  static readonly layer = Layer.effect(
    Tickets,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const fs = yield* FileSystem.FileSystem;
      const file = settings.ticketKeyFile;
      const unusable = (reason: string) => new TicketKeyUnusable({ file, reason });

      const pem = yield* fs
        .readFileString(file)
        .pipe(Effect.mapError((error) => unusable(error.message)));
      const body = PEM.exec(pem)?.[1];
      if (body === undefined) {
        return yield* unusable("it is no PEM of a PKCS#8 private key");
      }
      const der = yield* Effect.fromResult(Base64.decode(body.replace(/\s+/gu, ""))).pipe(
        Effect.mapError((error) => unusable(error.message)),
      );
      // Effect signs nothing: the key is the platform's own.
      const key = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.importKey("pkcs8", new Uint8Array(der), "Ed25519", false, ["sign"]),
        catch: (cause) => unusable(`it is no Ed25519 key: ${String(cause)}`),
      });

      return Tickets.of({
        issue: Effect.fn("Tickets.issue")(function* (ticket) {
          const now = yield* Clock.currentTimeMillis;
          const expires = Math.floor((now + Duration.toMillis(settings.ticketLifetime)) / 1000);
          const signed = [
            encoded({ alg: "EdDSA", typ: "JWT" }),
            encoded({
              sub: ticket.subject,
              name: ticket.name,
              sid: ticket.sessionId,
              exp: expires,
              access: ticket.access,
            }),
          ].join(".");
          const signature = yield* Effect.promise(() =>
            crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(signed)),
          );
          return {
            ticket: `${signed}.${Base64Url.encode(new Uint8Array(signature))}`,
            expiresAt: DateTime.makeUnsafe(expires * 1000),
          };
        }),
      });
    }),
  );
}
