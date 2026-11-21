import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Memory, moment, ordered } from "../store/memory.ts";
import type { Client } from "./schemas.ts";
import {
  GrantsStore,
  type NewClient,
  type NewCode,
  type NewGrant,
  type NewToken,
} from "./store.ts";

/** Grants kept in memory. */
export const makeGrantsStoreMemory = Effect.fn("GrantsStore.makeMemory")(function* () {
  const memory = yield* Memory;

  const drop = (grantId: string) => {
    memory.oauthGrants.delete(grantId);
    for (const [hash, code] of memory.oauthCodes) {
      if (code.grantId === grantId) {
        memory.oauthCodes.delete(hash);
      }
    }
    for (const [hash, token] of memory.oauthTokens) {
      if (token.grantId === grantId) {
        memory.oauthTokens.delete(hash);
      }
    }
  };

  const insertClient = Effect.fn("GrantsStore.insertClient")((client: NewClient) =>
    Effect.sync(() => {
      const kept: Client = { ...client, createdAt: moment(client.createdAt) };
      memory.oauthClients.set(kept.id, kept);
      return kept;
    }),
  );

  const findClient = Effect.fn("GrantsStore.findClient")((id: string) =>
    Effect.sync(() => Option.fromUndefinedOr(memory.oauthClients.get(id))),
  );

  const deleteClientsNeverGranted = Effect.fn("GrantsStore.deleteClientsNeverGranted")(
    (before: Date) =>
      Effect.sync(() => {
        for (const client of memory.oauthClients.values()) {
          if (
            !memory.oauthClientsGranted.has(client.id) &&
            DateTime.toEpochMillis(client.createdAt) < before.getTime()
          ) {
            memory.oauthClients.delete(client.id);
          }
        }
      }),
  );

  const insertGrant = Effect.fn("GrantsStore.insertGrant")((grant: NewGrant) =>
    Effect.sync(() => {
      memory.oauthClientsGranted.add(grant.clientId);
      for (const before of memory.oauthGrants.values()) {
        if (before.accountId === grant.accountId && before.clientId === grant.clientId) {
          drop(before.id);
        }
      }
      memory.oauthGrants.set(grant.id, {
        ...grant,
        clientName: memory.oauthClients.get(grant.clientId)?.name ?? "",
        createdAt: moment(grant.createdAt),
      });
    }),
  );

  const listGrants = Effect.fn("GrantsStore.listGrants")((accountId: string) =>
    Effect.sync(() =>
      ordered(memory.oauthGrants.values(), (grant) => grant.createdAt).filter(
        (grant) => grant.accountId === accountId,
      ),
    ),
  );

  const findGrant = Effect.fn("GrantsStore.findGrant")((id: string) =>
    Effect.sync(() => Option.fromUndefinedOr(memory.oauthGrants.get(id))),
  );

  const deleteGrant = Effect.fn("GrantsStore.deleteGrant")((id: string) =>
    Effect.sync(() => drop(id)),
  );

  const insertCode = Effect.fn("GrantsStore.insertCode")((code: NewCode) =>
    Effect.sync(() => {
      memory.oauthCodes.set(code.codeHash, code);
    }),
  );

  const takeCode = Effect.fn("GrantsStore.takeCode")((codeHash: string, now: Date) =>
    Effect.sync(() => {
      const code = memory.oauthCodes.get(codeHash);
      const grant = code === undefined ? undefined : memory.oauthGrants.get(code.grantId);
      if (code === undefined || grant === undefined || code.expiresAt <= now) {
        return Option.none();
      }
      memory.oauthCodes.delete(codeHash);
      return Option.some({
        grantId: code.grantId,
        clientId: grant.clientId,
        redirectUri: code.redirectUri,
        codeChallenge: code.codeChallenge,
      });
    }),
  );

  const insertToken = Effect.fn("GrantsStore.insertToken")((token: NewToken) =>
    Effect.sync(() => {
      memory.oauthTokens.set(token.tokenHash, token);
    }),
  );

  const good = (tokenHash: string, kind: NewToken["kind"] | undefined, now: Date) =>
    Option.fromUndefinedOr(memory.oauthTokens.get(tokenHash)).pipe(
      Option.filter(
        (token) => (kind === undefined || token.kind === kind) && token.expiresAt > now,
      ),
      Option.flatMap((token) => Option.fromUndefinedOr(memory.oauthGrants.get(token.grantId))),
    );

  const takeRefreshToken = Effect.fn("GrantsStore.takeRefreshToken")(
    (tokenHash: string, now: Date) =>
      Effect.sync(() => {
        const grant = good(tokenHash, "refresh", now);
        if (Option.isSome(grant)) {
          memory.oauthTokens.delete(tokenHash);
        }
        return grant;
      }),
  );

  const findByAccessToken = Effect.fn("GrantsStore.findByAccessToken")(
    (tokenHash: string, now: Date) => Effect.sync(() => good(tokenHash, "access", now)),
  );

  const findByToken = Effect.fn("GrantsStore.findByToken")((tokenHash: string, now: Date) =>
    Effect.sync(() => good(tokenHash, undefined, now)),
  );

  const deleteExpired = Effect.fn("GrantsStore.deleteExpired")((now: Date) =>
    Effect.sync(() => {
      for (const kept of [memory.oauthCodes, memory.oauthTokens]) {
        for (const [hash, one] of kept) {
          if (one.expiresAt <= now) {
            kept.delete(hash);
          }
        }
      }
    }),
  );

  return GrantsStore.of({
    insertClient,
    findClient,
    deleteClientsNeverGranted,
    insertGrant,
    listGrants,
    findGrant,
    deleteGrant,
    insertCode,
    takeCode,
    insertToken,
    takeRefreshToken,
    findByAccessToken,
    findByToken,
    deleteExpired,
  });
});

export const layerTest = Layer.effect(GrantsStore, makeGrantsStoreMemory());
