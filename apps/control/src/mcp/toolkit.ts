import {
  Forbidden,
  NodeRefused,
  NodeUnreachable,
  NoNode,
  ProxyConfig,
  Session,
  SessionHasNoNode,
  SessionNotFound,
  Snapshot,
  SnapshotNotFound,
  WorkspaceNotFound,
} from "@aperture-browser/control-api";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as Schema from "effect/Schema";

const said = (description: string) => ({ description });

const sessionId = Schema.NonEmptyString.annotate(said("The session's id."));
const snapshotId = Schema.NonEmptyString.annotate(said("The snapshot's id."));
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
  NoNode,
  NodeUnreachable,
  NodeRefused,
]);

/** A tool that changes nothing. */
const reads = <T extends Tool.Any>(tool: T) =>
  tool.annotate(Tool.Readonly, true).annotate(Tool.Destructive, false) as T;

/** A tool that changes something, and takes nothing away. */
const writes = <T extends Tool.Any>(tool: T) => tool.annotate(Tool.Destructive, false) as T;

const SessionsList = reads(
  Tool.make("sessions.list", {
    description: "List the sessions this token reaches, with the state of each.",
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
    description: "List the snapshots this token reaches: what sessions are created from.",
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

/**
 * What the control plane itself does for an agent: the sessions and snapshots of the API,
 * each tool the same call. What is done inside a session is the session's own tools.
 */
export const ControlTools = Toolkit.make(
  SessionsList,
  SessionsGet,
  SessionsCreate,
  SessionsUpdate,
  SessionsSuspend,
  SessionsResume,
  SessionsDelete,
  SessionsPromote,
  SnapshotsList,
  SnapshotsGet,
  SnapshotsUpdate,
  SnapshotsDelete,
);
