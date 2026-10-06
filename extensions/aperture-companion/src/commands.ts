import { ApiRequestError } from "@aperture-browser/api-client";
import * as Schema from "effect/Schema";
import { CompanionError } from "./chrome.ts";
import { NonEmptyString, TabId, Tags, TeleportDestination } from "./schema.ts";

// Messages the popup sends to the service worker, which runs them once the user grants the
// site access they need. The popup usually closes while Chromium asks, so the worker keeps
// them as pending commands.

export const ConnectCommand = Schema.Struct({
  type: Schema.Literal("connect"),
  id: NonEmptyString,
  origin: Schema.String,
  token: Schema.String,
});
export type ConnectCommand = typeof ConnectCommand.Type;

export const ConnectOAuthCommand = Schema.Struct({
  type: Schema.Literal("connect-oauth"),
  id: NonEmptyString,
  origin: Schema.String,
});

export const TeleportTabsCommand = Schema.Struct({
  type: Schema.Literal("teleport-tabs"),
  id: NonEmptyString,
  tabIds: Schema.Array(TabId).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  activeTabId: TabId,
  baseSnapshotName: Schema.optionalKey(NonEmptyString),
  label: Schema.optionalKey(Schema.String),
  tags: Tags,
  destination: TeleportDestination,
  snapshotName: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
}).check(
  Schema.makeFilter(({ activeTabId, destination, snapshotName, tabIds }) => {
    const issues: Schema.FilterIssue[] = [];
    if (!tabIds.includes(activeTabId)) {
      issues.push({ path: ["activeTabId"], issue: "The active tab must be teleported" });
    }
    if (destination === "snapshot" && !snapshotName?.trim()) {
      issues.push({ path: ["snapshotName"], issue: "Snapshot name is required" });
    }
    return issues;
  }),
);
export type TeleportTabsCommand = typeof TeleportTabsCommand.Type;

export const CompanionCommand = Schema.Union([
  ConnectCommand,
  ConnectOAuthCommand,
  TeleportTabsCommand,
]);
export type CompanionCommand = typeof CompanionCommand.Type;

export const ListSnapshotsCommand = Schema.Struct({
  type: Schema.Literal("list-snapshots"),
  id: NonEmptyString,
  connectionId: NonEmptyString,
});
export const DisconnectCommand = Schema.Struct({
  type: Schema.Literal("disconnect"),
  id: NonEmptyString,
  connectionId: NonEmptyString,
});
export const CompanionMessage = Schema.Union([
  CompanionCommand,
  ListSnapshotsCommand,
  DisconnectCommand,
]);

/** Why a command failed, as a tagged error the popup decodes back into its class. */
export const CommandError = Schema.Union([CompanionError, ApiRequestError]);
export type CommandError = typeof CommandError.Type;

export const CommandFailed = Schema.Struct({ ok: Schema.Literal(false), error: CommandError });
export type CommandFailed = typeof CommandFailed.Type;

export const ConnectResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), connectionId: NonEmptyString }),
  CommandFailed,
]);
export type ConnectResult = typeof ConnectResult.Type;

export const ListSnapshotsResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), snapshots: Schema.Array(Schema.String) }),
  CommandFailed,
]);

export const DisconnectResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  CommandFailed,
]);

export const TeleportTabsResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), warnings: Schema.Array(Schema.String) }),
  CommandFailed,
]);
export type TeleportTabsResult = typeof TeleportTabsResult.Type;
