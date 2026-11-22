import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { isAfter, Memory, moment, ordered } from "../store/memory.ts";
import type { Account, ApiToken } from "./schemas.ts";
import { AccountsStore, type NewAccount, type NewApiToken } from "./store.ts";

/** Accounts kept in memory. */
export const makeAccountsStoreMemory = Effect.fn("AccountsStore.makeMemory")(function* () {
  const memory = yield* Memory;

  const insert = Effect.fn("AccountsStore.insert")((account: NewAccount) =>
    Effect.sync(() => {
      const kept: Account = {
        id: account.id,
        name: account.name,
        admin: account.admin,
        kind: account.kind,
        email: account.person?.email ?? null,
        createdAt: moment(account.createdAt),
        disabledAt: null,
      };
      memory.accounts.set(kept.id, kept);
      if (account.person !== null) {
        memory.accountsOfPeople.set(account.person.id, kept.id);
      }
      return kept;
    }),
  );

  const insertForPerson = Effect.fn("AccountsStore.insertForPerson")(
    (account: NewAccount & { readonly person: NonNullable<NewAccount["person"]> }) =>
      Effect.suspend(() => {
        const theirs = memory.accounts.get(memory.accountsOfPeople.get(account.person.id) ?? "");
        return theirs === undefined ? insert(account) : Effect.succeed(theirs);
      }),
  );

  const list = Effect.fn("AccountsStore.list")(() =>
    Effect.sync(() => ordered(memory.accounts.values(), (account) => account.createdAt)),
  );

  const find = Effect.fn("AccountsStore.find")((id: string) =>
    Effect.sync(() => Option.fromUndefinedOr(memory.accounts.get(id))),
  );

  const findByPerson = Effect.fn("AccountsStore.findByPerson")((personId: string) =>
    Effect.sync(() =>
      Option.fromUndefinedOr(memory.accountsOfPeople.get(personId)).pipe(
        Option.flatMap((id) => Option.fromUndefinedOr(memory.accounts.get(id))),
      ),
    ),
  );

  const findByEmail = Effect.fn("AccountsStore.findByEmail")((email: string) =>
    Effect.sync(() =>
      Option.fromUndefinedOr(
        ordered(memory.accounts.values(), (account) => account.createdAt).find(
          (account) => account.email?.toLowerCase() === email.toLowerCase(),
        ),
      ),
    ),
  );

  const setDisabled = Effect.fn("AccountsStore.setDisabled")((id: string, at: Date | null) =>
    Effect.sync(() =>
      Option.fromUndefinedOr(memory.accounts.get(id)).pipe(
        Option.map((account) => {
          const kept: Account = {
            ...account,
            disabledAt: at === null ? null : (account.disabledAt ?? moment(at)),
          };
          memory.accounts.set(id, kept);
          return kept;
        }),
      ),
    ),
  );

  const change = Effect.fn("AccountsStore.change")(
    (
      id: string,
      said: { readonly name?: string | undefined; readonly admin?: boolean | undefined },
    ) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(memory.accounts.get(id)).pipe(
          Option.map((account) => {
            const kept: Account = {
              ...account,
              name: said.name ?? account.name,
              admin: said.admin ?? account.admin,
            };
            memory.accounts.set(id, kept);
            return kept;
          }),
        ),
      ),
  );

  /** What a database removes with an account by itself is removed here by hand. */
  const delete_ = Effect.fn("AccountsStore.delete")((id: string) =>
    Effect.sync(() => {
      memory.accounts.delete(id);
      for (const [person, account] of memory.accountsOfPeople) {
        if (account === id) {
          memory.accountsOfPeople.delete(person);
        }
      }
      for (const [hash, token] of memory.apiTokens) {
        if (token.accountId === id) {
          memory.apiTokens.delete(hash);
        }
      }
      for (const [hash, share] of memory.shares) {
        if (share.accountId === id) {
          memory.shares.delete(hash);
        }
      }
      for (const members of memory.workspaceMembers.values()) {
        members.delete(id);
      }
      for (const session of memory.sessions.values()) {
        if (session.accountId === id && session.workspaceId !== null) {
          memory.sessions.set(session.id, { ...session, accountId: null });
        }
      }
      for (const snapshot of memory.snapshots.values()) {
        if (snapshot.accountId === id && snapshot.workspaceId !== null) {
          memory.snapshots.set(snapshot.id, { ...snapshot, accountId: null });
        }
      }
      for (const grant of memory.oauthGrants.values()) {
        if (grant.accountId !== id) {
          continue;
        }
        memory.oauthGrants.delete(grant.id);
        for (const [hash, code] of memory.oauthCodes) {
          if (code.grantId === grant.id) {
            memory.oauthCodes.delete(hash);
          }
        }
        for (const [hash, token] of memory.oauthTokens) {
          if (token.grantId === grant.id) {
            memory.oauthTokens.delete(hash);
          }
        }
      }
    }),
  );

  const insertToken = Effect.fn("AccountsStore.insertToken")((token: NewApiToken) =>
    Effect.sync(() => {
      const kept: ApiToken = {
        id: token.id,
        accountId: token.accountId,
        name: token.name,
        createdAt: moment(token.createdAt),
        expiresAt: token.expiresAt === null ? null : moment(token.expiresAt),
        revokedAt: null,
        scopes: token.scopes,
        resources: token.resources,
      };
      memory.apiTokens.set(token.tokenHash, kept);
      return kept;
    }),
  );

  const listTokens = Effect.fn("AccountsStore.listTokens")((accountId: string) =>
    Effect.sync(() =>
      ordered(memory.apiTokens.values(), (token) => token.createdAt).filter(
        (token) => token.accountId === accountId,
      ),
    ),
  );

  const findToken = Effect.fn("AccountsStore.findToken")((id: string) =>
    Effect.sync(() =>
      Option.fromUndefinedOr([...memory.apiTokens.values()].find((token) => token.id === id)),
    ),
  );

  const revokeToken = Effect.fn("AccountsStore.revokeToken")((id: string, now: Date) =>
    Effect.sync(() => {
      for (const [hash, token] of memory.apiTokens) {
        if (token.id === id && token.revokedAt === null) {
          memory.apiTokens.set(hash, { ...token, revokedAt: moment(now) });
        }
      }
    }),
  );

  const findByTokenHash = Effect.fn("AccountsStore.findByTokenHash")(
    (tokenHash: string, now: Date) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(memory.apiTokens.get(tokenHash)).pipe(
          Option.filter(
            (token) =>
              token.revokedAt === null &&
              (token.expiresAt === null || isAfter(token.expiresAt, now)),
          ),
          Option.flatMap((token) =>
            Option.fromUndefinedOr(memory.accounts.get(token.accountId)).pipe(
              Option.map((account) => ({
                account,
                scopes: token.scopes,
                resources: token.resources,
              })),
            ),
          ),
        ),
      ),
  );

  return AccountsStore.of({
    insert,
    insertForPerson,
    list,
    find,
    findByPerson,
    findByEmail,
    change,
    setDisabled,
    delete: delete_,
    insertToken,
    listTokens,
    findToken,
    revokeToken,
    findByTokenHash,
  });
});

export const layerTest = Layer.effect(AccountsStore, makeAccountsStoreMemory());
