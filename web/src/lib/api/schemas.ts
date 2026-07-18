import { z } from "zod";

const passkeyAuthenticatorTransportSchema = z.enum([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

const passkeyCredentialDescriptorSchema = z.object({
  id: z.string(),
  type: z.literal("public-key"),
  transports: z.array(passkeyAuthenticatorTransportSchema).optional(),
});

const passkeyExtensionsSchema = z
  .object({
    appid: z.string().optional(),
    credProps: z.boolean().optional(),
    hmacCreateSecret: z.boolean().optional(),
    minPinLength: z.boolean().optional(),
  })
  .optional();

const passkeyHintSchema = z.enum(["hybrid", "security-key", "client-device"]);
const passkeyUserVerificationSchema = z.enum(["discouraged", "preferred", "required"]);

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

export const resourceModeSchema = z.enum(["all", "allowlist"]);

export const resourceGrantSchema = z.object({
  resourceType: z.enum(["session", "snapshot"]),
  resourceId: z.string(),
});

export const principalSchema = z.object({
  type: z.enum(["api_token", "user", "system"]),
  id: z.string(),
  authMethod: z.enum(["api_token", "oidc", "passkey"]),
  tokenId: z.string().nullable(),
  userId: z.string().nullable().optional(),
  name: z.string(),
  authorityType: z.enum(["system_admin", "tenant"]),
  tenantId: z.string().nullable(),
  scopes: z.array(z.string()),
  resourceMode: resourceModeSchema,
  resourceGrants: z.array(resourceGrantSchema),
});

export const authMeSchema = z.object({
  principal: principalSchema,
  selectedTenant: tenantSchema.nullable(),
  availableTenants: z.array(tenantSchema),
});

export const oidcProvidersSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      loginUrl: z.string(),
    }),
  ),
});

export const passkeyLoginOptionsSchema = z.object({
  publicKey: z.object({
    challenge: z.string(),
    timeout: z.number().optional(),
    rpId: z.string().optional(),
    allowCredentials: z.array(passkeyCredentialDescriptorSchema).optional(),
    userVerification: passkeyUserVerificationSchema.optional(),
    hints: z.array(passkeyHintSchema).optional(),
    extensions: passkeyExtensionsSchema,
  }),
});

export const passkeyRegistrationOptionsSchema = z.object({
  publicKey: z.object({
    rp: z.object({
      id: z.string().optional(),
      name: z.string(),
    }),
    user: z.object({
      id: z.string(),
      name: z.string(),
      displayName: z.string(),
    }),
    challenge: z.string(),
    pubKeyCredParams: z.array(
      z.object({
        alg: z.union([
          z.literal(-7),
          z.literal(-8),
          z.literal(-35),
          z.literal(-36),
          z.literal(-37),
          z.literal(-38),
          z.literal(-39),
          z.literal(-257),
          z.literal(-258),
          z.literal(-259),
        ]),
        type: z.literal("public-key"),
      }),
    ),
    timeout: z.number().optional(),
    excludeCredentials: z.array(passkeyCredentialDescriptorSchema).optional(),
    authenticatorSelection: z
      .object({
        authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
        requireResidentKey: z.boolean().optional(),
        residentKey: z.enum(["discouraged", "preferred", "required"]).optional(),
        userVerification: passkeyUserVerificationSchema.optional(),
      })
      .optional(),
    hints: z.array(passkeyHintSchema).optional(),
    attestation: z.enum(["direct", "enterprise", "indirect", "none"]).optional(),
    attestationFormats: z
      .array(
        z.enum(["fido-u2f", "packed", "android-safetynet", "android-key", "tpm", "apple", "none"]),
      )
      .optional(),
    extensions: passkeyExtensionsSchema,
  }),
});

export const passkeySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

export const passkeysSchema = z.object({
  passkeys: z.array(passkeySchema),
});

export const passkeyMutationSchema = z.object({
  passkey: passkeySchema,
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

export const sessionMediaSchema = z.object({
  mode: z.enum(["auto", "cdp"]),
  webrtcProducer: z.boolean(),
  iceServers: z.array(iceServerSchema).default([]),
});

export const browserStatusSchema = z.object({
  sessionId: z.string(),
  cdpUrl: z.string(),
  media: sessionMediaSchema,
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
  lastConnectedAt: z.string().nullable().optional(),
  suspendedAt: z.string().nullable().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  cdpUrl: z.string().optional(),
  sessionToken: z.string().optional(),
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
  createdByType: z.enum(["api_token", "user", "system"]),
  createdById: z.string().nullable(),
  parentTokenId: z.string().nullable(),
  resourceMode: resourceModeSchema,
  resourceGrants: z.array(resourceGrantSchema),
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
  sessionToken: z.string(),
});

export const sessionMutationResponseSchema = z.object({
  session: sessionSchema,
  cdpUrl: z.string().optional(),
  sessionToken: z.string().optional(),
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
export type ResourceMode = z.infer<typeof resourceModeSchema>;
export type ResourceGrant = z.infer<typeof resourceGrantSchema>;
export type OIDCProviders = z.infer<typeof oidcProvidersSchema>;
export type PasskeyLoginOptions = z.infer<typeof passkeyLoginOptionsSchema>;
export type PasskeyRegistrationOptions = z.infer<typeof passkeyRegistrationOptionsSchema>;
export type Passkey = z.infer<typeof passkeySchema>;
export type Session = z.infer<typeof sessionSchema>;
export type SessionMedia = z.infer<typeof sessionMediaSchema>;
export type BrowserStatus = z.infer<typeof browserStatusSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type ApiToken = z.infer<typeof tokenSchema>;
export type TenantsPage = z.infer<typeof tenantsPageSchema>;
export type SessionsPage = z.infer<typeof sessionsPageSchema>;
export type SessionsBulkResponse = z.infer<typeof sessionsBulkResponseSchema>;
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
