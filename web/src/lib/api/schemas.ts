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

export const sessionStatusSchema = z.enum(["creating", "running", "deleted", "expired", "failed"]);

const iceServerSchema = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export const sessionMediaSchema = z.object({
  mode: z.enum(["auto", "cdp"]),
  webrtcProducer: z.boolean(),
  iceServers: z.array(iceServerSchema).default([]),
});

export const screencastStatusSchema = z.object({
  active: z.boolean(),
  path: z.string().optional(),
  startedAt: z.string().optional(),
  stoppedAt: z.string().optional(),
  fps: z.number().optional(),
  codec: z.string().optional(),
  sizeBytes: z.number().optional(),
});

export const sessionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  baseSnapshotName: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  status: sessionStatusSchema,
  browserChannel: z.string().optional(),
  media: sessionMediaSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable().optional(),
  stoppedAt: z.string().nullable().optional(),
  deletedAt: z.string().nullable(),
  expiresAt: z.string(),
  tags: z.record(z.string(), z.string()).optional(),
  cdpUrl: z.string().optional(),
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
export const snapshotsPageSchema = paginatedSchema(snapshotSchema);
export const tokensPageSchema = paginatedSchema(tokenSchema);

export const browserChannelSchema = z.object({
  name: z.string(),
});

export const browserChannelsSchema = z.object({
  channels: z.array(browserChannelSchema),
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
  cdpUrl: z.string(),
  cdpToken: z.string(),
});

export const sessionMutationResponseSchema = z.object({
  session: sessionSchema,
  cdpUrl: z.string().optional(),
  cdpToken: z.string().optional(),
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
export type SessionMedia = z.infer<typeof sessionMediaSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type ApiToken = z.infer<typeof tokenSchema>;
export type TenantsPage = z.infer<typeof tenantsPageSchema>;
export type SessionsPage = z.infer<typeof sessionsPageSchema>;
export type SnapshotsPage = z.infer<typeof snapshotsPageSchema>;
export type TokensPage = z.infer<typeof tokensPageSchema>;
export type BrowserChannel = z.infer<typeof browserChannelSchema>;
export type BrowserChannelsResponse = z.infer<typeof browserChannelsSchema>;
export type ResourceEvent = z.infer<typeof eventSchema>;
export type EventsPage = z.infer<typeof eventsPageSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type SessionMutationResponse = z.infer<typeof sessionMutationResponseSchema>;
export type SnapshotMutationResponse = z.infer<typeof snapshotMutationResponseSchema>;
export type PromoteSessionResponse = z.infer<typeof promoteSessionResponseSchema>;
export type CreateTokenResponse = z.infer<typeof createTokenResponseSchema>;
