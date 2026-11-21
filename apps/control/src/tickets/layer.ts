import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { TicketKeyUnusable } from "../errors.ts";
import { Settings } from "../settings/service.ts";
import type { TicketRequest } from "./schemas.ts";
import { Tickets } from "./service.ts";

const PEM = /-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----/u;

const encoded = (part: object) => Base64Url.encode(JSON.stringify(part));

/** The key tickets are signed with, as the settings name its file. */
const readKey = Effect.fn("Tickets.readKey")(function* () {
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
  return yield* Effect.tryPromise({
    try: () => crypto.subtle.importKey("pkcs8", new Uint8Array(der), "Ed25519", false, ["sign"]),
    catch: (cause) => unusable(`it is no Ed25519 key: ${String(cause)}`),
  });
});

export const makeTickets = Effect.fn("Tickets.make")(function* () {
  const settings = yield* Settings;
  const key = yield* readKey();

  const issue = Effect.fn("Tickets.issue")(function* (ticket: TicketRequest) {
    const now = yield* Clock.currentTimeMillis;
    const until =
      ticket.until === undefined || ticket.until === null
        ? undefined
        : Math.floor(DateTime.toEpochMillis(ticket.until) / 1000);
    const expires = Math.min(
      Math.floor((now + Duration.toMillis(settings.ticketLifetime)) / 1000),
      until ?? Infinity,
    );
    const signed = [
      encoded({ alg: "EdDSA", typ: "JWT" }),
      encoded({
        sub: ticket.subject,
        name: ticket.name,
        sid: ticket.sessionId,
        exp: expires,
        access: ticket.access,
        ...(until === undefined ? {} : { until }),
      }),
    ].join(".");
    const signature = yield* Effect.promise(() =>
      crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(signed)),
    );
    return {
      ticket: `${signed}.${Base64Url.encode(new Uint8Array(signature))}`,
      expiresAt: DateTime.makeUnsafe(expires * 1000),
    };
  });

  return Tickets.of({ issue });
});

export const layer = Layer.effect(Tickets, makeTickets());
