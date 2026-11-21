import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import type { Account, ApiToken } from "../accounts/schemas.ts";
import type { Client, Grant } from "../grants/schemas.ts";
import type { NewCode, NewToken } from "../grants/store.ts";
import type { NodeRecord, RegistrationToken } from "../nodes/schemas.ts";
import type { Session } from "../sessions/schemas.ts";
import type { Share } from "../shares/schemas.ts";
import type { Snapshot } from "../snapshots/schemas.ts";
import type { Workspace, WorkspaceRole } from "../workspaces/schemas.ts";

/**
 * What the stores keep when there is no database: for checks of what is above the stores.
 * One for all of them, as a database is, since some answer from what another wrote.
 */
export interface MemoryShape {
  readonly accounts: Map<string, Account>;
  /** The accounts people sign in as, by who signs in. */
  readonly accountsOfPeople: Map<string, string>;
  /** By the token's digest. */
  readonly apiTokens: Map<string, ApiToken>;
  /** By the token's digest. */
  readonly registrationTokens: Map<string, RegistrationToken>;
  readonly nodes: Map<string, NodeRecord>;
  readonly sessions: Map<string, Session>;
  /** Sessions' routing, sealed, by the session's id. */
  readonly sessionProxies: Map<string, string>;
  /** Share links, by the digest of each one's secret. */
  readonly shares: Map<string, Share>;
  readonly snapshots: Map<string, Snapshot>;
  readonly workspaces: Map<string, Workspace>;
  /** Who is in each workspace, by the workspace's id and then the account's. */
  readonly workspaceMembers: Map<string, Map<string, WorkspaceRole>>;
  readonly oauthClients: Map<string, Client>;
  /** The apps that were given a grant at some time, by their ids. */
  readonly oauthClientsGranted: Set<string>;
  readonly oauthGrants: Map<string, Grant>;
  /** By the code's digest. */
  readonly oauthCodes: Map<string, NewCode>;
  /** By the token's digest. */
  readonly oauthTokens: Map<string, NewToken>;
}

export class Memory extends Context.Service<Memory, MemoryShape>()(
  "@aperture-browser/control/Memory",
) {}

export const layer = Layer.sync(Memory, () =>
  Memory.of({
    accounts: new Map(),
    accountsOfPeople: new Map(),
    apiTokens: new Map(),
    registrationTokens: new Map(),
    nodes: new Map(),
    sessions: new Map(),
    sessionProxies: new Map(),
    shares: new Map(),
    snapshots: new Map(),
    workspaces: new Map(),
    workspaceMembers: new Map(),
    oauthClients: new Map(),
    oauthClientsGranted: new Set(),
    oauthGrants: new Map(),
    oauthCodes: new Map(),
    oauthTokens: new Map(),
  }),
);

/** Rows in the order the database gives them: the oldest first, and by id among equals. */
export const ordered = <A extends { readonly id: string }>(
  rows: Iterable<A>,
  at: (row: A) => DateTime.Utc,
): ReadonlyArray<A> =>
  [...rows].toSorted(
    (one, other) =>
      DateTime.toEpochMillis(at(one)) - DateTime.toEpochMillis(at(other)) ||
      one.id.localeCompare(other.id),
  );

export const moment = (date: Date): DateTime.Utc => DateTime.fromDateUnsafe(date);

export const isAfter = (moment: DateTime.Utc, since: Date) =>
  DateTime.toEpochMillis(moment) > since.getTime();
