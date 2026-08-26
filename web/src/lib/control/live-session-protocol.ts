import { z } from "zod";
import { recordingSchema } from "#/lib/api/schemas.ts";

export const LIVE_SESSION_PROTOCOL = "aperture-session.v1";

export type CollaborationRole = "owner" | "editor" | "viewer";
export type CollaborationLeaseMode = "implicit" | "explicit";
export type CollaborationPhase = "idle" | "connecting" | "connected" | "disconnected";

export type CollaborationParticipant = {
  clientId: string;
  name: string;
  avatarHash: string;
  role: CollaborationRole | "automation";
  activeTargetId?: string;
  followingClientId?: string;
  holdingInput: boolean;
  leaseMode?: CollaborationLeaseMode;
  recovering?: boolean;
};

export type CollaborationCursor = {
  clientId: string;
  targetId: string;
  x: number;
  y: number;
};

export type CollaborationPaintPhase = "start" | "move" | "end";

export type CollaborationPaintPoint = {
  targetId: string;
  strokeId: string;
  color: string;
  width: number;
  phase: CollaborationPaintPhase;
  x: number;
  y: number;
};

export type CollaborationPaintEvent =
  | { type: "point"; message: CollaborationPaintPoint & { clientId: string } }
  | { type: "clear" };

export type CollaborationError = {
  code: string;
  message: string;
};

const targetSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    url: z.string(),
    loading: z.boolean(),
    viewport: z
      .object({
        width: z.number().positive(),
        height: z.number().positive(),
        contentWidth: z.number().positive(),
        contentHeight: z.number().positive(),
        canvasWidth: z.number().positive(),
        canvasHeight: z.number().positive(),
        deviceScaleFactor: z.number().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

const participantSchema = z
  .object({
    clientId: z.string(),
    name: z.string(),
    avatarHash: z.string(),
    role: z.enum(["owner", "editor", "viewer", "automation"]),
    activeTargetId: z.string().optional(),
    followingClientId: z.string().optional(),
    holdingInput: z.boolean(),
    leaseMode: z.enum(["implicit", "explicit"]).optional(),
    recovering: z.boolean().optional(),
  })
  .strict();

const snapshotSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("session.snapshot"),
    clientId: z.string(),
    resumeSecret: z.string(),
    role: z.enum(["owner", "editor", "viewer"]),
    transport: z.enum(["webrtc", "websocket"]),
    holderClientId: z.string().optional(),
    mode: z.enum(["implicit", "explicit"]).optional(),
    activeTargetId: z.string().optional(),
    targets: z.array(targetSchema).optional().default([]),
    participants: z.array(participantSchema).optional().default([]),
    recordings: z.array(recordingSchema).optional().default([]),
  })
  .strict();

const presenceStateSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("presence.state"),
    participants: z.array(participantSchema).optional().default([]),
  })
  .strict();

const inputStateSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("input.state"),
    holderClientId: z.string().optional(),
    mode: z.enum(["implicit", "explicit"]).optional(),
  })
  .strict();

const cursorSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("presence.cursor"),
    clientId: z.string(),
    targetId: z.string(),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    realtimeCounter: z.number().int().positive(),
  })
  .strict();

const cursorClearSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("presence.cursor.clear"),
    clientId: z.string(),
    realtimeCounter: z.number().int().positive(),
  })
  .strict();

const paintSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("paint.point"),
    clientId: z.string(),
    targetId: z.string(),
    strokeId: z.string(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    width: z.number().min(1).max(16),
    phase: z.enum(["start", "move", "end"]),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    realtimeCounter: z.number().int().positive().optional(),
  })
  .strict();

const targetsStateSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("targets.state"),
    activeTargetId: z.string().optional(),
    targets: z.array(targetSchema).optional().default([]),
  })
  .strict();

const recordingsStateSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("recordings.state"),
    recordings: z.array(recordingSchema).optional().default([]),
  })
  .strict();

const errorSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  })
  .strict();

const commandResultTypes = [
  "target.select.result",
  "target.create.result",
  "target.close.result",
  "page.navigate.result",
  "page.history-back.result",
  "page.history-forward.result",
  "page.reload.result",
  "page.stop-loading.result",
  "viewport.set.result",
  "recording.start.result",
  "recording.stop.result",
  "recording.cancel.result",
] as const;

const commandResultSchema = z
  .object({
    version: z.literal(1),
    type: z.enum(commandResultTypes),
    requestId: z.string(),
    ok: z.boolean(),
    code: z.string().optional(),
    message: z.string().optional(),
    targetId: z.string().optional(),
    recording: recordingSchema.optional(),
  })
  .strict();

export const liveSessionServerMessageSchema = z.discriminatedUnion("type", [
  snapshotSchema,
  presenceStateSchema,
  inputStateSchema,
  cursorSchema,
  cursorClearSchema,
  paintSchema,
  targetsStateSchema,
  recordingsStateSchema,
  errorSchema,
  commandResultSchema,
]);

export type LiveSessionServerMessage = z.infer<typeof liveSessionServerMessageSchema>;
export type LiveSessionSnapshot = z.infer<typeof snapshotSchema>;
export type LiveSessionTarget = z.infer<typeof targetSchema>;
export type LiveSessionCommandResult = z.infer<typeof commandResultSchema>;

export const rasterFrameSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("presentation.frame"),
    targetId: z.string(),
    frameId: z.number().int(),
    format: z.literal("jpeg"),
    width: z.number().positive(),
    height: z.number().positive(),
    deviceScaleFactor: z.number().positive(),
    scrollOffsetX: z.number(),
    scrollOffsetY: z.number(),
    timestamp: z.number().optional(),
  })
  .strict();
