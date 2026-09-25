import * as Schema from "effect/Schema";
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

export const CompanionCommand = Schema.Union([ConnectCommand, TeleportTabsCommand]);
export type CompanionCommand = typeof CompanionCommand.Type;

const Failed = Schema.Struct({ ok: Schema.Literal(false), error: NonEmptyString });

export const ConnectResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), connectionId: NonEmptyString }),
  Failed,
]);
export type ConnectResult = typeof ConnectResult.Type;

export const TeleportTabsResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), warnings: Schema.Array(Schema.String) }),
  Failed,
]);
export type TeleportTabsResult = typeof TeleportTabsResult.Type;
