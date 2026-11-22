import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
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
  // Effect signs nothing: the keys are the platform's own. The public key is the private
  // one without what makes it private, and is what a ticket that comes back is checked by.
  return yield* Effect.tryPromise({
    try: async () => {
      const whole = await crypto.subtle.importKey("pkcs8", new Uint8Array(der), "Ed25519", true, [
        "sign",
      ]);
      const { kty, crv, x } = await crypto.subtle.exportKey("jwk", whole);
      return {
        signing: await crypto.subtle.importKey("pkcs8", new Uint8Array(der), "Ed25519", false, [
          "sign",
        ]),
        checking: await crypto.subtle.importKey("jwk", { kty, crv, x }, "Ed25519", false, [
          "verify",
        ]),
      };
    },
    catch: (cause) => unusable(`it is no Ed25519 key: ${String(cause)}`),
  });
});

/** What of a ticket's claims this program reads again. */
const Claims = Schema.fromJsonString(Schema.Struct({ sid: Schema.String, exp: Schema.Number }));
const decodeClaims = Schema.decodeUnknownOption(Claims);

export const makeTickets = Effect.fn("Tickets.make")(function* () {
  const settings = yield* Settings;
  const keys = yield* readKey();

  const issue = Effect.fn("Tickets.issue")(function* (ticket: TicketRequest) {
    const now = yield* Clock.currentTimeMillis;
    const until =
      ticket.until === undefined || ticket.until === null
        ? undefined
        : Math.floor(DateTime.toEpochMillis(ticket.until) / 1000);
    const expires = Math.min(
      Math.floor((now + Duration.toMillis(ticket.lasts ?? settings.ticketLifetime)) / 1000),
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
        ...(ticket.path === undefined ? {} : { path: ticket.path }),
      }),
    ].join(".");
    const signature = yield* Effect.promise(() =>
      crypto.subtle.sign("Ed25519", keys.signing, new TextEncoder().encode(signed)),
    );
    return {
      ticket: `${signed}.${Base64Url.encode(new Uint8Array(signature))}`,
      expiresAt: DateTime.makeUnsafe(expires * 1000),
    };
  });

  const sessionOf = Effect.fn("Tickets.sessionOf")(function* (ticket: string) {
    const [header, claims, signature, ...more] = ticket.split(".");
    if (
      header === undefined ||
      claims === undefined ||
      signature === undefined ||
      more.length > 0
    ) {
      return Option.none<string>();
    }
    const signed = Base64Url.decode(signature);
    const said = Result.flatMap(Base64Url.decodeString(claims), (json) =>
      Result.fromOption(decodeClaims(json), () => undefined),
    );
    if (Result.isFailure(signed) || Result.isFailure(said)) {
      return Option.none<string>();
    }
    const good = yield* Effect.promise(() =>
      crypto.subtle.verify(
        "Ed25519",
        keys.checking,
        new Uint8Array(signed.success),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    return good && said.success.exp * 1000 > now ? Option.some(said.success.sid) : Option.none();
  });

  return Tickets.of({ issue, sessionOf });
});

export const layer = Layer.effect(Tickets, makeTickets());
