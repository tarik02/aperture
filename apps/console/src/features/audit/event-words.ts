import type { EventKind, SettingKey, SettingLevel } from "@aperture-browser/control-api";
import type { Event } from "#/features/audit/event.queries.ts";
import { LEVEL_WORDS, SETTING_WORDS } from "#/features/settings/setting-words.ts";

const said = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

/** Which setting an event is of, by its title, and at which level, as a sentence ends. */
const settingOf = (event: Event) => {
  const key = said(event.detail["key"]);
  const level = said(event.detail["level"]);
  const title = key === undefined ? undefined : SETTING_WORDS[key as SettingKey]?.label;
  const where = level === undefined ? undefined : LEVEL_WORDS[level as SettingLevel];
  return `${title === undefined ? "a setting" : `“${title}”`} for the ${where ?? "instance"}`;
};

/** What someone proved themselves by, as a sentence ends with it. */
const proven = (event: Event) => {
  const method = said(event.detail["method"]);
  if (method === "passkey") {
    return "with a passkey";
  }
  if (method === "two_factor") {
    return "with a password and a code";
  }
  if (method === "provider") {
    return `through ${said(event.detail["provider"]) ?? "a provider"}`;
  }
  return "with a password";
};

/**
 * What happened, in one plain sentence, for every kind of event there is: who did it and
 * what it was about stand beside it.
 */
export const HAPPENED: Readonly<Record<EventKind, (event: Event) => string>> = {
  "sign_in.succeeded": (event) => `Signed in ${proven(event)}`,
  "sign_in.failed": (event) => `Did not sign in ${proven(event)}`,
  "account.created": (event) =>
    event.detail["provisioned"] === true
      ? "Got an account by signing in through a provider"
      : event.detail["first"] === true
        ? "Became the first admin, with the link the control plane logged"
        : `Made the ${event.detail["kind"] === "person" ? "person" : "service account"}`,
  "account.changed": (event) =>
    event.detail["admin"] === true
      ? "Made the account an admin"
      : event.detail["admin"] === false
        ? "Made the account no admin"
        : `Renamed the account from ${said(event.detail["from"]) ?? "another name"}`,
  "account.disabled": () => "Disabled the account",
  "account.enabled": () => "Enabled the account",
  "account.removed": () => "Deleted the account",
  "account.setup_link_made": () => "Made a setup link",
  "account.second_factor_reset": () => "Turned two-factor sign-in off",
  "account.passkeys_removed": () => "Removed the passkeys",
  "token.created": () => "Made the API token",
  "token.revoked": () => "Revoked the API token",
  "grant.given": () => "Connected the app",
  "grant.revoked": (event) =>
    event.detail["by"] === "app"
      ? "The app disconnected itself"
      : event.detail["by"] === "token_reused"
        ? "Disconnected the app: a refresh token of it was used twice"
        : "Disconnected the app",
  "registration_token.created": () => "Made the registration token",
  "registration_token.revoked": () => "Revoked the registration token",
  "workspace.created": () => "Made the workspace",
  "workspace.renamed": (event) =>
    `Renamed the workspace from ${said(event.detail["from"]) ?? "another name"}`,
  "workspace.deleted": () => "Deleted the workspace",
  "workspace.member_admitted": (event) =>
    `Let ${said(event.detail["account"]) ?? "an account"} in as ${said(event.detail["role"]) ?? "member"}`,
  "workspace.member_dismissed": (event) =>
    `Took ${said(event.detail["account"]) ?? "an account"} out`,
  "session.created": () => "Created the session",
  "session.suspended": () => "Suspended the session",
  "session.resumed": () => "Resumed the session",
  "session.deleted": (event) =>
    said(event.detail["reason"]) === undefined
      ? "Deleted the session"
      : `Deleted the session: ${said(event.detail["reason"])}`,
  "session.pinned": () => "Pinned the session",
  "session.unpinned": () => "Unpinned the session",
  "snapshot.taken": () => "Saved the snapshot",
  "snapshot.replaced": () => "Replaced the snapshot with a newer one",
  "snapshot.deleted": () => "Deleted the snapshot",
  "share.created": (event) =>
    `Made the share link to ${event.detail["role"] === "control" ? "control" : "watch"}`,
  "share.revoked": () => "Revoked the share link",
  "share.joined": () => "Joined through the share link",
  "node.registered": () => "Registered",
  "node.refused": (event) =>
    `Refused another node that asked for the name from ${said(event.detail["internalUrl"]) ?? "elsewhere"}`,
  "node.released": () => "Let the name go to the next node that registers",
  "node.silent": () => "Fell silent",
  "provider.added": () => "Added the sign-in provider",
  "provider.changed": () => "Changed the sign-in provider",
  "provider.enabled": () => "Enabled the sign-in provider",
  "provider.disabled": () => "Disabled the sign-in provider",
  "provider.removed": () => "Removed the sign-in provider",
  "setting.changed": (event) => `Changed ${settingOf(event)}`,
  "setting.cleared": (event) => `Cleared ${settingOf(event)}`,
};

/** The kinds of events as a list to choose from tells them, those of one thing together. */
export const KINDS: ReadonlyArray<{
  readonly label: string;
  readonly kinds: ReadonlyArray<{ readonly value: EventKind; readonly label: string }>;
}> = [
  {
    label: "Signing in",
    kinds: [
      { value: "sign_in.succeeded", label: "Signed in" },
      { value: "sign_in.failed", label: "Did not sign in" },
      { value: "provider.added", label: "Provider added" },
      { value: "provider.changed", label: "Provider changed" },
      { value: "provider.enabled", label: "Provider enabled" },
      { value: "provider.disabled", label: "Provider disabled" },
      { value: "provider.removed", label: "Provider removed" },
    ],
  },
  {
    label: "Accounts",
    kinds: [
      { value: "account.created", label: "Account made" },
      { value: "account.disabled", label: "Account disabled" },
      { value: "account.enabled", label: "Account enabled" },
      { value: "account.removed", label: "Account deleted" },
      { value: "account.setup_link_made", label: "Setup link made" },
      { value: "account.second_factor_reset", label: "Two-factor reset" },
      { value: "account.passkeys_removed", label: "Passkeys removed" },
    ],
  },
  {
    label: "Tokens and apps",
    kinds: [
      { value: "token.created", label: "API token made" },
      { value: "token.revoked", label: "API token revoked" },
      { value: "grant.given", label: "App connected" },
      { value: "grant.revoked", label: "App disconnected" },
    ],
  },
  {
    label: "Workspaces",
    kinds: [
      { value: "workspace.created", label: "Workspace made" },
      { value: "workspace.renamed", label: "Workspace renamed" },
      { value: "workspace.deleted", label: "Workspace deleted" },
      { value: "workspace.member_admitted", label: "Member let in" },
      { value: "workspace.member_dismissed", label: "Member taken out" },
    ],
  },
  {
    label: "Sessions",
    kinds: [
      { value: "session.created", label: "Session created" },
      { value: "session.suspended", label: "Session suspended" },
      { value: "session.resumed", label: "Session resumed" },
      { value: "session.deleted", label: "Session deleted" },
      { value: "session.pinned", label: "Session pinned" },
      { value: "session.unpinned", label: "Session unpinned" },
    ],
  },
  {
    label: "Snapshots",
    kinds: [
      { value: "snapshot.taken", label: "Snapshot saved" },
      { value: "snapshot.replaced", label: "Snapshot replaced" },
      { value: "snapshot.deleted", label: "Snapshot deleted" },
    ],
  },
  {
    label: "Share links",
    kinds: [
      { value: "share.created", label: "Share link made" },
      { value: "share.revoked", label: "Share link revoked" },
      { value: "share.joined", label: "Guest joined" },
    ],
  },
  {
    label: "Nodes",
    kinds: [
      { value: "registration_token.created", label: "Registration token made" },
      { value: "registration_token.revoked", label: "Registration token revoked" },
      { value: "node.registered", label: "Node registered" },
      { value: "node.refused", label: "Node refused its name" },
      { value: "node.released", label: "Node released" },
      { value: "node.silent", label: "Node fell silent" },
    ],
  },
  {
    label: "Settings",
    kinds: [
      { value: "setting.changed", label: "Setting changed" },
      { value: "setting.cleared", label: "Setting cleared" },
    ],
  },
];

/** What a thing an event is about is, in a word. */
export const ABOUT: Readonly<Record<NonNullable<Event["resource"]>["kind"], string>> = {
  account: "Account",
  token: "API token",
  grant: "App",
  registration_token: "Registration token",
  workspace: "Workspace",
  session: "Session",
  snapshot: "Snapshot",
  share: "Share link",
  node: "Node",
  provider: "Sign-in provider",
};

/** Who did it, where they have no name of their own. */
export const ACTOR: Readonly<Record<Event["actor"]["kind"], string>> = {
  account: "An account",
  guest: "A guest",
  bootstrap: "Bootstrap token",
  anonymous: "Someone not signed in",
  system: "Aperture",
};
