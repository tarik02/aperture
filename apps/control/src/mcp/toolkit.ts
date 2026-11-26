import {
  Access,
  AccountNotFound,
  CurrentAccount,
  EventKind,
  EventPage,
  EventResource,
  FILE_LINK_MOST,
  FileLink,
  FileLinkInvalid,
  Forbidden,
  NodeRefused,
  NodeUnreachable,
  NoNode,
  ProxyConfig,
  ObservedState,
  QuotaExceeded,
  SettingInvalid,
  SettingKey,
  SettingOutOfBounds,
  SettingValue,
  SettingView,
  Session,
  SessionFilePath,
  SessionHasNoNode,
  SessionNotFound,
  Share,
  ShareCreated,
  ShareNotFound,
  ShareRole,
  Snapshot,
  SnapshotNotFound,
  Workspace,
  WorkspaceInUse,
  WorkspaceMember,
  WorkspaceNotFound,
} from "@aperture-browser/control-api";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as Schema from "effect/Schema";

const said = (description: string) => ({ description });

const sessionId = Schema.NonEmptyString.annotate(said("The session's id."));
const snapshotId = Schema.NonEmptyString.annotate(said("The snapshot's id."));
const workspaceId = Schema.NonEmptyString.annotate(said("The workspace's id."));
const accountId = Schema.NonEmptyString.annotate(said("The account's id."));
const inWorkspace = Schema.NonEmptyString.annotate(
  said("Only what is of this workspace; `none` for what is the account's own."),
);
const tagged = Schema.NonEmptyString.annotate(
  said("Only what has this tag: `name=value`, or `name` for whatever it is set to."),
);
const Tags = Schema.Record(Schema.NonEmptyString, Schema.String).annotate(
  said("Names, each with what it is set to. They take the place of the tags there were."),
);

/** How a tool is refused: as the same call of the API is. */
const Refusal = Schema.Union([
  Forbidden,
  SessionNotFound,
  SessionHasNoNode,
  SnapshotNotFound,
  WorkspaceNotFound,
  WorkspaceInUse,
  AccountNotFound,
  ShareNotFound,
  FileLinkInvalid,
  NoNode,
  NodeUnreachable,
  NodeRefused,
  SettingInvalid,
  SettingOutOfBounds,
  QuotaExceeded,
]);

/** A tool that changes nothing. */
const reads = <T extends Tool.Any>(tool: T) =>
  tool.annotate(Tool.Readonly, true).annotate(Tool.Destructive, false) as T;

/** A tool that changes something, and takes nothing away. */
const writes = <T extends Tool.Any>(tool: T) => tool.annotate(Tool.Destructive, false) as T;

const SessionsList = reads(
  Tool.make("sessions.list", {
    description:
      "List the sessions this token reaches, with the state of each. The arguments narrow the list; a session has to be all of them.",
    parameters: Schema.Struct({
      workspace_id: Schema.optional(inWorkspace),
      state: Schema.optional(ObservedState.annotate(said("Only sessions its node says are this."))),
      label: Schema.optional(
        Schema.NonEmptyString.annotate(said("Only sessions whose label has this in it.")),
      ),
      tag: Schema.optional(tagged),
    }),
    success: Schema.Struct({ sessions: Schema.Array(Session) }),
    failure: Refusal,
  }),
);

const SessionsGet = reads(
  Tool.make("sessions.get", {
    description: "Get one session: its state, its label and tags, and where it is reached.",
    parameters: Schema.Struct({ session_id: sessionId }),
    success: Session,
    failure: Refusal,
  }),
);

const SessionsCreate = writes(
  Tool.make("sessions.create", {
    description:
      "Create a browser session and start it. Its `id` is the `session_id` the browser tools take. Without a snapshot it starts with an empty profile, signed in nowhere.",
    parameters: Schema.Struct({
      snapshot_id: Schema.optional(
        Schema.NonEmptyString.annotate(said("A snapshot whose profile the session starts with.")),
      ),
      label: Schema.optional(Schema.NonEmptyString.annotate(said("What the session is called."))),
      tags: Schema.optional(Tags),
      workspace_id: Schema.optional(
        Schema.NonEmptyString.annotate(
          said("The workspace the session is of; the account's own without."),
        ),
      ),
      proxy: Schema.optional(ProxyConfig),
    }),
    success: Session,
    failure: Refusal,
  }),
);

const SessionsUpdate = writes(
  Tool.make("sessions.update", {
    description: "Change a session's label and tags. What is left out stays as it is.",
    parameters: Schema.Struct({
      session_id: sessionId,
      label: Schema.optional(
        Schema.NullOr(Schema.NonEmptyString).annotate(said("The new label; null takes it away.")),
      ),
      tags: Schema.optional(Tags),
    }),
    success: Session,
    failure: Refusal,
  }),
);

const SessionsSuspend = writes(
  Tool.make("sessions.suspend", {
    description: "Suspend a running session. Its profile and files are kept until it is resumed.",
    parameters: Schema.Struct({ session_id: sessionId }),
    success: Session,
    failure: Refusal,
  }),
);

const SessionsResume = writes(
  Tool.make("sessions.resume", {
    description: "Resume a suspended session.",
    parameters: Schema.Struct({ session_id: sessionId }),
    success: Session,
    failure: Refusal,
  }),
);

const SessionsDelete = Tool.make("sessions.delete", {
  description: "Delete a session with its profile and files. Snapshots taken of it stay.",
  parameters: Schema.Struct({ session_id: sessionId }),
  success: Schema.Struct({ deleted: Schema.String }),
  failure: Refusal,
});

const SessionsPromote = writes(
  Tool.make("sessions.promote", {
    description:
      "Take a snapshot of a session's profile, which sessions are then created from. With `replaces` it takes the place of an older snapshot, which is deleted.",
    parameters: Schema.Struct({
      session_id: sessionId,
      name: Schema.optional(Schema.NonEmptyString),
      description: Schema.optional(Schema.NonEmptyString),
      tags: Schema.optional(Tags),
      replaces: Schema.optional(
        Schema.NonEmptyString.annotate(
          said(
            "A snapshot this one takes the place of. Its name, description and tags stay where nothing else is given.",
          ),
        ),
      ),
    }),
    success: Snapshot,
    failure: Refusal,
  }),
);

const SnapshotsList = reads(
  Tool.make("snapshots.list", {
    description:
      "List the snapshots this token reaches: what sessions are created from. The arguments narrow the list; a snapshot has to be all of them.",
    parameters: Schema.Struct({
      workspace_id: Schema.optional(inWorkspace),
      name: Schema.optional(
        Schema.NonEmptyString.annotate(said("Only snapshots whose name has this in it.")),
      ),
      tag: Schema.optional(tagged),
    }),
    success: Schema.Struct({ snapshots: Schema.Array(Snapshot) }),
    failure: Refusal,
  }),
);

const SnapshotsGet = reads(
  Tool.make("snapshots.get", {
    description: "Get one snapshot.",
    parameters: Schema.Struct({ snapshot_id: snapshotId }),
    success: Snapshot,
    failure: Refusal,
  }),
);

const SnapshotsUpdate = writes(
  Tool.make("snapshots.update", {
    description:
      "Change a snapshot's name, description and tags. What is left out stays as it is; null takes a name or a description away.",
    parameters: Schema.Struct({
      snapshot_id: snapshotId,
      name: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
      description: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
      tags: Schema.optional(Tags),
    }),
    success: Snapshot,
    failure: Refusal,
  }),
);

const SnapshotsDelete = Tool.make("snapshots.delete", {
  description: "Delete a snapshot. Sessions created from it keep working.",
  parameters: Schema.Struct({ snapshot_id: snapshotId }),
  success: Schema.Struct({ deleted: Schema.String }),
  failure: Refusal,
});

const SessionProxy = Schema.Struct({ proxy: Schema.NullOr(ProxyConfig) });

const SessionsProxy = reads(
  Tool.make("sessions.proxy", {
    description:
      "Get how a session's browser connections are routed, as it was last set here: its rules and the upstreams they name. `proxy` is null where every connection goes out from the session's node.",
    parameters: Schema.Struct({ session_id: sessionId }),
    success: SessionProxy,
    failure: Refusal,
  }),
);

const SessionsSetProxy = writes(
  Tool.make("sessions.set_proxy", {
    description:
      "Set how a running session's browser connections are routed, from then on. The first rule whose `match` fits a connection decides: `via` is `direct`, `refuse`, `local` (a tunnel a client attached), an upstream's name, or a proxy's URL. What is given takes the place of the routing there was; null turns it off.",
    parameters: Schema.Struct({
      session_id: sessionId,
      proxy: Schema.NullOr(ProxyConfig),
    }),
    success: SessionProxy,
    failure: Refusal,
  }),
);

const SessionsTicket = writes(
  Tool.make("sessions.ticket", {
    description:
      'Make a ticket into a session, and the address a person opens to see the session in their browser. Give the `url` to someone who is to look at the session or do something in it, such as signing in; it lets them in until `expires_at`, and a page that is open stays open after. Without `access` they watch; to let them act, give `access` such as {"input":"rw","tabs":"rw","lease":"rw","clipboard":"rw"}. The ticket is also what a request to the session\'s own routes carries as a bearer token. For someone who is to come back later, make a share link with shares.create.',
    parameters: Schema.Struct({
      session_id: sessionId,
      name: Schema.optional(
        Schema.NonEmptyString.annotate(
          said(
            "What the others in the session call the ticket's holder; the account's name without.",
          ),
        ),
      ),
      access: Schema.optional(
        Access.annotate(
          said(
            "What the holder may do besides watching, area by area: `r`, `w` or `rw`. Anything but watching takes a token for sessions:write.",
          ),
        ),
      ),
    }),
    success: Schema.Struct({
      url: Schema.String,
      ticket: Schema.String,
      expires_at: Schema.String,
    }),
    failure: Refusal,
  }),
);

const SessionsFileLink = writes(
  Tool.make("sessions.file_link", {
    description:
      "Make a short-lived address for one file of a session: fetch it with a plain HTTP GET and no other credentials, as `curl -fLo out.mkv <url>`. The session's `files` tool lists the files there are and gives each `path`: recordings, screenshots, downloads and uploads. With `write`, the address takes a file instead: PUT its bytes there, as `curl -fT report.pdf <url>`, and it is an upload of the session, which the `upload` tool then gives to a page.",
    parameters: Schema.Struct({
      session_id: sessionId,
      path: SessionFilePath.annotate(
        said(
          "The file below the session's files, as `recordings/1a2b.mkv` or `uploads/report.pdf`.",
        ),
      ),
      write: Schema.optional(
        Schema.Boolean.annotate(
          said("Make an address a file is put at; `path` is `uploads/<name>`."),
        ),
      ),
      expires_in_seconds: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: FILE_LINK_MOST })).annotate(
          said("How long the address is good for; 300 without."),
        ),
      ),
    }),
    success: FileLink,
    failure: Refusal,
  }),
);

const shareId = Schema.NonEmptyString.annotate(said("The share link's id."));

const SharesList = reads(
  Tool.make("shares.list", {
    description:
      "List the share links into a session: who they are for, what they let a guest do, and the one tab they show where they show one.",
    parameters: Schema.Struct({ session_id: sessionId }),
    success: Schema.Struct({ shares: Schema.Array(Share) }),
    failure: Refusal,
  }),
);

const SharesCreate = writes(
  Tool.make("shares.create", {
    description:
      "Make a share link into a session for someone with no account. Whoever opens its `url` is a guest: they see the session, and with `control` give input, change tabs and use the clipboard; files, routing and automation are never a guest's. The `url` is told once, here. The link is good until it is revoked or runs out.",
    parameters: Schema.Struct({
      session_id: sessionId,
      name: Schema.optional(
        Schema.String.check(Schema.isMaxLength(100)).annotate(
          said(
            "What you know the link by, such as who it is for; its guests are called so until they say otherwise. Without, it names nobody.",
          ),
        ),
      ),
      role: ShareRole.annotate(said("`watch`, or `control` to let guests act in the session.")),
      tab: Schema.optional(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate(
          said(
            "The number of the one tab its guests are to see, as the session's `tabs` tool numbers it: they are shown no other, and open none. The whole session, without.",
          ),
        ),
      ),
      expires_in_hours: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 87_600 })).annotate(
          said("How long it is good for; until it is revoked, without."),
        ),
      ),
    }),
    success: ShareCreated,
    failure: Refusal,
  }),
);

const SharesRevoke = Tool.make("shares.revoke", {
  description: "Take a share link back. Its guests are put out of the session at once.",
  parameters: Schema.Struct({ session_id: sessionId, share_id: shareId }),
  success: Schema.Struct({ revoked: Schema.String }),
  failure: Refusal,
});

const WorkspaceRole = Schema.Literals(["member", "admin"]);

const WorkspacesList = reads(
  Tool.make("workspaces.list", {
    description:
      "List the workspaces this token's account is in, with what it does in each. A session or a snapshot made with a workspace's id is all its members'.",
    success: Schema.Struct({ workspaces: Schema.Array(Workspace) }),
    failure: Refusal,
  }),
);

const WorkspacesMembers = reads(
  Tool.make("workspaces.members", {
    description:
      "List who is in a workspace: people and service accounts, each a member or an admin.",
    parameters: Schema.Struct({ workspace_id: workspaceId }),
    success: Schema.Struct({ members: Schema.Array(WorkspaceMember) }),
    failure: Refusal,
  }),
);

const WorkspacesCreate = writes(
  Tool.make("workspaces.create", {
    description: "Make a workspace. The account that makes it is its admin.",
    parameters: Schema.Struct({ name: Schema.NonEmptyString }),
    success: Workspace,
    failure: Refusal,
  }),
);

const WorkspacesRename = writes(
  Tool.make("workspaces.rename", {
    description: "Rename a workspace. It is for an admin of the workspace to do.",
    parameters: Schema.Struct({ workspace_id: workspaceId, name: Schema.NonEmptyString }),
    success: Workspace,
    failure: Refusal,
  }),
);

const WorkspacesDelete = Tool.make("workspaces.delete", {
  description:
    "Delete a workspace that has no sessions and no snapshots left. It is for an admin of the workspace to do.",
  parameters: Schema.Struct({ workspace_id: workspaceId }),
  success: Schema.Struct({ deleted: Schema.String }),
  failure: Refusal,
});

const WorkspacesAdmit = writes(
  Tool.make("workspaces.admit", {
    description:
      "Let an account into a workspace, or change what one that is in it does there. It is for an admin of the workspace to do.",
    parameters: Schema.Struct({
      workspace_id: workspaceId,
      account_id: accountId,
      role: WorkspaceRole,
    }),
    success: Schema.Struct({ admitted: Schema.String, role: WorkspaceRole }),
    failure: Refusal,
  }),
);

const WorkspacesDismiss = Tool.make("workspaces.dismiss", {
  description:
    "Take an account out of a workspace. What it made there stays the workspace's. It is for an admin of the workspace to do.",
  parameters: Schema.Struct({ workspace_id: workspaceId, account_id: accountId }),
  success: Schema.Struct({ dismissed: Schema.String }),
  failure: Refusal,
});

const SessionsPin = writes(
  Tool.make("sessions.pin", {
    description:
      "Pin a session, which keeps it from being deleted by itself as its settings would have it, or unpin it. The settings say who pins and how many sessions are pinned at most.",
    parameters: Schema.Struct({ session_id: sessionId, pinned: Schema.Boolean }),
    success: Session,
    failure: Refusal,
  }),
);

/** Where a setting is said, as the settings tools name it. */
const SettingsWhere = {
  level: Schema.Literals(["instance", "workspace", "account", "session"]).annotate(
    said(
      "Where: the deployment, a workspace (with `workspace_id`), this token's account (with `workspace_id` for what it has in one), or a session (with `session_id`).",
    ),
  ),
  workspace_id: Schema.optional(workspaceId),
  session_id: Schema.optional(sessionId),
};

const SettingsGet = reads(
  Tool.make("settings.get", {
    description:
      "Tell every setting as a level has it: what the level says, what it comes to there and where that comes from (a level, the configuration or each node's own), and the bounds the levels above it set. Times are in seconds, and null is never or no limit.",
    parameters: Schema.Struct(SettingsWhere),
    success: Schema.Struct({ settings: Schema.Array(SettingView) }),
    failure: Refusal,
  }),
);

const SettingsSet = writes(
  Tool.make("settings.set", {
    description:
      "Say what a workspace, this token's account or a session says of one setting, in place of what it said: a value the levels below may say otherwise, and bounds they may not cross (`min` and `max` for a time or a count, `allowed` for a choice). A value or a bound that crosses a bound above is refused, with the level that sets it. The deployment's settings are the API's alone to change.",
    parameters: Schema.Struct({
      ...SettingsWhere,
      level: Schema.Literals(["workspace", "account", "session"]),
      key: SettingKey,
      value: Schema.optional(SettingValue),
      min: Schema.optional(Schema.Number),
      max: Schema.optional(Schema.Number),
      allowed: Schema.optional(Schema.Array(SettingValue)),
    }),
    success: SettingView,
    failure: Refusal,
  }),
);

const SettingsClear = writes(
  Tool.make("settings.clear", {
    description:
      "Have a workspace, this token's account or a session say nothing of one setting: what the levels above say holds there again.",
    parameters: Schema.Struct({
      ...SettingsWhere,
      level: Schema.Literals(["workspace", "account", "session"]),
      key: SettingKey,
    }),
    success: SettingView,
    failure: Refusal,
  }),
);

const AccountGet = reads(
  Tool.make("account.get", {
    description:
      "Tell whose token this is and what it is held to: its account, its `scopes`, and the `resources` it reaches where it is held to some. Call it to learn why a tool was refused.",
    success: CurrentAccount,
    failure: Refusal,
  }),
);

const EventsList = reads(
  Tool.make("events.list", {
    description:
      "List what was done, the newest first: sessions created and deleted, snapshots taken, share links made and used, sign-ins and the rest, each with who did it. It tells of this token's account and of the workspaces that is in. `next` is the `cursor` of the events before these.",
    parameters: Schema.Struct({
      kind: Schema.optional(EventKind),
      resource_kind: Schema.optional(EventResource.fields.kind),
      resource_id: Schema.optional(
        Schema.NonEmptyString.annotate(said("Only events about this: a session's id, say.")),
      ),
      workspace_id: Schema.optional(workspaceId),
      since: Schema.optional(
        Schema.DateTimeUtcFromString.annotate(
          said("Only events from this moment on, as ISO 8601."),
        ),
      ),
      cursor: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{1,16}_[0-9a-f-]{36}$/u))),
      limit: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })).annotate(
          said("How many at most; 50 without."),
        ),
      ),
    }),
    success: EventPage,
    failure: Refusal,
  }),
);

/**
 * What the control plane itself does for an agent: the sessions, snapshots, share links,
 * workspaces and events of the API, each tool the same call and held to the same scopes.
 * What is done inside a session is the session's own tools. What only an admin does, and
 * what makes credentials that last, tokens and accounts, is the API's alone.
 */
export const ControlTools = Toolkit.make(
  SessionsList,
  SessionsGet,
  SessionsCreate,
  SessionsUpdate,
  SessionsSuspend,
  SessionsResume,
  SessionsDelete,
  SessionsPin,
  SessionsPromote,
  SessionsProxy,
  SessionsSetProxy,
  SessionsTicket,
  SessionsFileLink,
  SharesList,
  SharesCreate,
  SharesRevoke,
  SnapshotsList,
  SnapshotsGet,
  SnapshotsUpdate,
  SnapshotsDelete,
  WorkspacesList,
  WorkspacesMembers,
  WorkspacesCreate,
  WorkspacesRename,
  WorkspacesDelete,
  WorkspacesAdmit,
  WorkspacesDismiss,
  SettingsGet,
  SettingsSet,
  SettingsClear,
  AccountGet,
  EventsList,
);
