import { z } from "zod";

export const pageMetaSchema = z.object({
  limit: z.number(),
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
});

export function paginatedSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    meta: pageMetaSchema,
  });
}

export const tenantSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
});

export const principalSchema = z.object({
  tokenId: z.string(),
  name: z.string(),
  authorityType: z.enum(["system_admin", "tenant"]),
  tenantId: z.string().nullable(),
  scopes: z.array(z.string()),
});

export const authMeSchema = z.object({
  principal: principalSchema,
  selectedTenant: tenantSchema.nullable(),
});

export const healthSchema = z.object({
  status: z.literal("ok"),
});

export const sessionStatusSchema = z.enum([
  "creating",
  "running",
  "suspended",
  "deleted",
  "expired",
  "failed",
]);

const iceServerSchema = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export const browserModeSchema = z.enum(["headed", "headless"]);

export const sessionCapabilitiesSchema = z.object({
  state: z.enum(["active", "prospective", "unavailable"]),
  liveView: z.object({
    transports: z.array(z.enum(["webrtc", "cdp"])),
  }),
  recording: z
    .object({
      mechanism: z.enum(["compositor", "cdp"]),
      scope: z.enum(["window", "page"]),
      modes: z.array(z.enum(["tab", "viewer"])),
      audio: z.boolean(),
      codecs: z.array(
        z.object({
          codec: z.enum(["vp8", "h264-va"]),
          mediaType: z.enum(["video/webm", "video/x-matroska"]),
        }),
      ),
      concurrencyLimit: z.number().int().positive(),
      cdp: z
        .object({
          formats: z.array(z.enum(["jpeg", "png"])),
          defaultFormat: z.enum(["jpeg", "png"]),
          defaultQuality: z.number().int().min(1).max(100),
        })
        .optional(),
    })
    .optional(),
});

export const sessionBrowserSchema = z.object({
  channel: z.string(),
  mode: browserModeSchema,
  args: z.array(z.string()).default([]),
});

export const sessionConnectionSchema = z.object({
  cdpUrl: z.string().optional(),
  sessionToken: z.string().optional(),
  webrtc: z
    .object({
      iceServers: z.array(iceServerSchema),
    })
    .optional(),
});

export const browserStatusSchema = z.object({
  sessionId: z.string(),
  browser: z.object({ mode: browserModeSchema }),
  capabilities: sessionCapabilitiesSchema,
  connection: sessionConnectionSchema,
  targets: z
    .array(
      z.object({
        targetId: z.string(),
        generation: z.number().int().positive(),
        state: z.enum(["pending", "ready", "unavailable", "closed"]),
        title: z.string(),
        url: z.string(),
        viewport: z.object({
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          deviceScaleFactor: z.number().positive(),
          contentWidth: z.number().int().positive(),
          contentHeight: z.number().int().positive(),
          canvasWidth: z.number().int().positive(),
          canvasHeight: z.number().int().positive(),
        }),
      }),
    )
    .default([]),
});

export const recordingSchema = z.object({
  recordingId: z.string(),
  mode: z.enum(["tab", "viewer"]),
  targetId: z.string(),
  captureGeneration: z.number().int().positive(),
  status: z.enum(["starting", "running", "stopped", "failed"]),
  stopReason: z.string().optional(),
  path: z.string(),
  startedAt: z.string(),
  stoppedAt: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  fps: z.number().int().positive(),
  bitrateKbps: z.number().int().positive(),
  codec: z.string(),
  cdp: z
    .object({
      format: z.enum(["jpeg", "png"]),
      quality: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
  acceptedFrames: z.number().int().nonnegative().optional(),
  droppedFrames: z.number().int().nonnegative().optional(),
});
export const recordingsSchema = z.array(recordingSchema);

export const sessionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  baseSnapshotName: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  status: sessionStatusSchema,
  browser: sessionBrowserSchema,
  capabilities: sessionCapabilitiesSchema,
  connection: sessionConnectionSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable().optional(),
  stoppedAt: z.string().nullable().optional(),
  deletedAt: z.string().nullable(),
  expiresAt: z.string(),
  lastConnectedAt: z.string().nullable().optional(),
  suspendedAt: z.string().nullable().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

export const snapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  tenantId: z.string(),
  parentSnapshotId: z.string().nullable().optional(),
  promotedFromSessionId: z.string().nullable().optional(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
  expiresAt: z.string().nullable().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

export const tokenSchema = z.object({
  id: z.string(),
  authorityType: z.enum(["system_admin", "tenant"]),
  tenantId: z.string().nullable(),
  name: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

export const tenantsPageSchema = paginatedSchema(tenantSchema);
export const sessionsPageSchema = paginatedSchema(sessionSchema);
export const sessionsBulkResponseSchema = z.object({
  sessions: z.array(sessionSchema),
});
export const snapshotsPageSchema = paginatedSchema(snapshotSchema);
export const tokensPageSchema = paginatedSchema(tokenSchema);

export const browserConfigurationSchema = z.object({
  channel: z.string(),
  mode: browserModeSchema,
  capabilities: sessionCapabilitiesSchema,
});

export const browserConfigurationsSchema = z.object({
  configurations: z.array(browserConfigurationSchema),
});

export const eventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  type: z.string(),
  message: z.string(),
  data: z.unknown(),
  createdAt: z.string(),
});

export const eventsPageSchema = paginatedSchema(eventSchema);

export const createSessionResponseSchema = z.object({
  session: sessionSchema,
});

export const sessionMutationResponseSchema = z.object({
  session: sessionSchema,
});

export const snapshotMutationResponseSchema = z.object({
  snapshot: snapshotSchema,
});

export const promoteSessionResponseSchema = z.object({
  snapshot: snapshotSchema,
});

export const createTokenResponseSchema = z.object({
  token: tokenSchema,
  rawToken: z.string(),
});

export type PageMeta = z.infer<typeof pageMetaSchema>;
export type Tenant = z.infer<typeof tenantSchema>;
export type AuthMeResponse = z.infer<typeof authMeSchema>;
export type AuthMePrincipal = z.infer<typeof principalSchema>;
export type AuthMeTenant = z.infer<typeof tenantSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type BrowserMode = z.infer<typeof browserModeSchema>;
export type SessionCapabilities = z.infer<typeof sessionCapabilitiesSchema>;
export type BrowserStatus = z.infer<typeof browserStatusSchema>;
export type Recording = z.infer<typeof recordingSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type ApiToken = z.infer<typeof tokenSchema>;
export type TenantsPage = z.infer<typeof tenantsPageSchema>;
export type SessionsPage = z.infer<typeof sessionsPageSchema>;
export type SessionsBulkResponse = z.infer<typeof sessionsBulkResponseSchema>;
export type SnapshotsPage = z.infer<typeof snapshotsPageSchema>;
export type TokensPage = z.infer<typeof tokensPageSchema>;
export type BrowserConfiguration = z.infer<typeof browserConfigurationSchema>;
export type BrowserConfigurationsResponse = z.infer<typeof browserConfigurationsSchema>;
export type ResourceEvent = z.infer<typeof eventSchema>;
export type EventsPage = z.infer<typeof eventsPageSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type SessionMutationResponse = z.infer<typeof sessionMutationResponseSchema>;
export type SnapshotMutationResponse = z.infer<typeof snapshotMutationResponseSchema>;
export type PromoteSessionResponse = z.infer<typeof promoteSessionResponseSchema>;
export type CreateTokenResponse = z.infer<typeof createTokenResponseSchema>;
