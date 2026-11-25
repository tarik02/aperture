import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { exportJWK, importJWK, importPKCS8, jwtVerify, SignJWT } from "jose";
import { TicketKeyUnusable } from "../errors.ts";
import { heldAccess } from "../policy/data.ts";
import { Policy } from "../policy/service.ts";
import { SessionsStore } from "../sessions/store.ts";
import { Settings } from "../settings/service.ts";
import type { TicketRequest } from "./schemas.ts";
import { Tickets } from "./service.ts";

const ALGORITHM = "EdDSA";

/** The key tickets are signed with, as the settings name its file. */
const readKey = Effect.fn("Tickets.readKey")(function* () {
  const settings = yield* Settings;
  const fs = yield* FileSystem.FileSystem;
  const file = settings.ticketKeyFile;
  const unusable = (reason: string) => new TicketKeyUnusable({ file, reason });

  const pem = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError((error) => unusable(error.message)));
  // The public key is the private one without what makes it private, and is what a ticket
  // that comes back is checked by. The key that signs is one nothing is read out of.
  return yield* Effect.tryPromise({
    try: async () => {
      const { kty, crv, x } = await exportJWK(
        await importPKCS8(pem, ALGORITHM, { extractable: true }),
      );
      return {
        signing: await importPKCS8(pem, ALGORITHM),
        checking: await importJWK({ kty, crv, x }, ALGORITHM),
      };
    },
    catch: (cause) => unusable(`it is no PEM of a PKCS#8 Ed25519 private key: ${String(cause)}`),
  });
});

/** What of a ticket's claims this program reads again. */
const Claims = Schema.Struct({ sub: Schema.String, sid: Schema.String, exp: Schema.Number });
const decodeClaims = Schema.decodeUnknownOption(Claims);

export const makeTickets = Effect.fn("Tickets.make")(function* () {
  const settings = yield* Settings;
  const keys = yield* readKey();
  const policy = yield* Policy;
  const sessions = yield* SessionsStore;

  /** What a ticket gives of what was asked: what the session's settings turn off is not. */
  const held = Effect.fn(function* (ticket: TicketRequest) {
    const session = yield* sessions.find(ticket.sessionId);
    if (Option.isNone(session)) {
      return ticket.access;
    }
    const effective = yield* policy.of({
      workspaceId: session.value.workspaceId,
      accountId: session.value.accountId,
      sessionId: session.value.id,
      pinned: session.value.pinned,
    });
    return heldAccess(ticket.access, effective);
  });

  const issue = Effect.fn("Tickets.issue")(function* (ticket: TicketRequest) {
    const now = yield* Clock.currentTimeMillis;
    const access = yield* held(ticket);
    const until =
      ticket.until === undefined || ticket.until === null
        ? undefined
        : Math.floor(DateTime.toEpochMillis(ticket.until) / 1000);
    const expires = Math.min(
      Math.floor((now + Duration.toMillis(ticket.lasts ?? settings.ticketLifetime)) / 1000),
      until ?? Infinity,
    );
    const signed = yield* Effect.promise(() =>
      new SignJWT({
        sub: ticket.subject,
        name: ticket.name,
        sid: ticket.sessionId,
        exp: expires,
        access,
        ...(until === undefined ? {} : { until }),
        ...(ticket.path === undefined ? {} : { path: ticket.path }),
      })
        .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
        .sign(keys.signing),
    );
    return {
      ticket: signed,
      expiresAt: DateTime.makeUnsafe(expires * 1000),
    };
  });

  const read = Effect.fn("Tickets.read")(function* (ticket: string) {
    const now = yield* Clock.currentTimeMillis;
    // One that is not signed with the key, or as the key signs, or has run out, is none.
    const said = yield* Effect.tryPromise(() =>
      jwtVerify(ticket, keys.checking, { algorithms: [ALGORITHM], currentDate: new Date(now) }),
    ).pipe(Effect.option);
    return Option.map(
      Option.flatMap(said, (verified) => decodeClaims(verified.payload)),
      (claims) => ({ subject: claims.sub, sessionId: claims.sid }),
    );
  });

  return Tickets.of({ issue, read });
});

export const layer = Layer.effect(Tickets, makeTickets());
