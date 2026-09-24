import { Effect, Schema } from "effect";
import * as Api from "@aperture/api-schema";

// Resources described by api/openapi.yaml come from the generated schemas. The schemas
// below cover the browser login flows and live session state, which the spec omits.

const passkeyAuthenticatorTransport = Schema.Literals([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

const passkeyCredentialDescriptor = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("public-key"),
  transports: Schema.optionalKey(Schema.mutable(Schema.Array(passkeyAuthenticatorTransport))),
});

const passkeyExtensions = Schema.optionalKey(
  Schema.Struct({
    appid: Schema.optionalKey(Schema.String),
    credProps: Schema.optionalKey(Schema.Boolean),
    hmacCreateSecret: Schema.optionalKey(Schema.Boolean),
    minPinLength: Schema.optionalKey(Schema.Boolean),
  }),
);

const passkeyHint = Schema.Literals(["hybrid", "security-key", "client-device"]);
const passkeyUserVerification = Schema.Literals(["discouraged", "preferred", "required"]);

export const LoginMethods = Schema.Struct({
  methods: Schema.Array(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("password") }),
      Schema.Struct({ type: Schema.Literal("api_token") }),
      Schema.Struct({ type: Schema.Literal("passkey") }),
      Schema.Struct({
        type: Schema.Literal("oidc"),
        id: Schema.String,
        name: Schema.String,
        loginUrl: Schema.String,
      }),
    ]),
  ),
});

export const PasskeyLoginOptions = Schema.Struct({
  publicKey: Schema.Struct({
    challenge: Schema.String,
    timeout: Schema.optionalKey(Schema.Number),
    rpId: Schema.optionalKey(Schema.String),
    allowCredentials: Schema.optionalKey(Schema.mutable(Schema.Array(passkeyCredentialDescriptor))),
    userVerification: Schema.optionalKey(passkeyUserVerification),
    hints: Schema.optionalKey(Schema.mutable(Schema.Array(passkeyHint))),
    extensions: passkeyExtensions,
  }),
});

export const PasskeyRegistrationOptions = Schema.Struct({
  publicKey: Schema.Struct({
    rp: Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      name: Schema.String,
    }),
    user: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      displayName: Schema.String,
    }),
    challenge: Schema.String,
    pubKeyCredParams: Schema.mutable(
      Schema.Array(
        Schema.Struct({
          alg: Schema.Literals([-7, -8, -35, -36, -37, -38, -39, -257, -258, -259]),
          type: Schema.Literal("public-key"),
        }),
      ),
    ),
    timeout: Schema.optionalKey(Schema.Number),
    excludeCredentials: Schema.optionalKey(
      Schema.mutable(Schema.Array(passkeyCredentialDescriptor)),
    ),
    authenticatorSelection: Schema.optionalKey(
      Schema.Struct({
        authenticatorAttachment: Schema.optionalKey(
          Schema.Literals(["platform", "cross-platform"]),
        ),
        requireResidentKey: Schema.optionalKey(Schema.Boolean),
        residentKey: Schema.optionalKey(Schema.Literals(["discouraged", "preferred", "required"])),
        userVerification: Schema.optionalKey(passkeyUserVerification),
      }),
    ),
    hints: Schema.optionalKey(Schema.mutable(Schema.Array(passkeyHint))),
    attestation: Schema.optionalKey(Schema.Literals(["direct", "enterprise", "indirect", "none"])),
    attestationFormats: Schema.optionalKey(
      Schema.mutable(
        Schema.Array(
          Schema.Literals([
            "fido-u2f",
            "packed",
            "android-safetynet",
            "android-key",
            "tpm",
            "apple",
            "none",
          ]),
        ),
      ),
    ),
    extensions: passkeyExtensions,
  }),
});

export const Passkey = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
});

export const Passkeys = Schema.Struct({
  passkeys: Schema.Array(Passkey),
});

export const PasskeyMutation = Schema.Struct({
  passkey: Passkey,
});

export const PasswordLoginResponse = Schema.Struct({
  mfaRequired: Schema.Boolean,
});

export const SecurityStatus = Schema.Struct({
  hasPassword: Schema.Boolean,
  totpEnabled: Schema.Boolean,
  recoveryCodesRemaining: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});

export const TOTPEnrollment = Schema.Struct({
  secret: Schema.String,
  otpauthUrl: Schema.String,
  qrCodeDataUrl: Schema.String,
});

export const RecoveryCodes = Schema.Struct({
  recoveryCodes: Schema.Array(Schema.String),
});

const positiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const emptyArray = Effect.succeed([]);

export const BrowserStatus = Schema.Struct({
  sessionId: Schema.String,
  cdpUrl: Schema.String,
  media: Api.SessionMedia,
  targets: Schema.Array(
    Schema.Struct({
      targetId: Schema.String,
      generation: positiveInt,
      state: Schema.Literals(["pending", "ready", "unavailable", "closed"]),
      title: Schema.String,
      url: Schema.String,
      viewport: Schema.Struct({
        width: positiveInt,
        height: positiveInt,
        deviceScaleFactor: Schema.Number.check(Schema.isGreaterThan(0)),
        contentWidth: positiveInt,
        contentHeight: positiveInt,
        canvasWidth: positiveInt,
        canvasHeight: positiveInt,
      }),
    }),
  ).pipe(Schema.withDecodingDefaultKey(emptyArray)),
});

/** A recording as the live session reports it. */
export const Recording = Schema.Struct({
  recordingId: Schema.String,
  mode: Schema.Literals(["tab", "viewer"]),
  targetId: Schema.String,
  captureGeneration: positiveInt,
  status: Schema.Literals(["starting", "running", "stopped", "failed"]),
  stopReason: Schema.optionalKey(Schema.String),
  path: Schema.String,
  startedAt: Schema.String,
  stoppedAt: Schema.optionalKey(Schema.String),
  sizeBytes: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  fps: positiveInt,
  bitrateKbps: positiveInt,
  codec: Schema.String,
});

export type PageMeta = Api.PageMeta;
export type Tenant = Api.Tenant;
export type User = Api.User;
export type UserInvitation = Api.UserInvitation;
export type TenantMembership = Api.TenantMembership;
export type AuthMeResponse = Api.AuthMe;
export type AuthMePrincipal = Api.Principal;
export type AuthMeTenant = Api.Tenant;
export type ResourceMode = Api.ResourceMode;
export type ResourceGrant = Api.ResourceGrant;
export type Scope = Api.Scope;
export type TenantScope = Api.TenantScope;
export type LoginMethods = typeof LoginMethods.Type;
export type PasskeyLoginOptions = typeof PasskeyLoginOptions.Type;
export type PasskeyRegistrationOptions = typeof PasskeyRegistrationOptions.Type;
export type Passkey = typeof Passkey.Type;
export type SecurityStatus = typeof SecurityStatus.Type;
export type TOTPEnrollment = typeof TOTPEnrollment.Type;
export type Session = Api.Session;
export type SessionMedia = Api.SessionMedia;
export type IceServer = Api.IceServer;
export type BrowserStatus = typeof BrowserStatus.Type;
export type Recording = typeof Recording.Type;
export const SessionStatus = Api.SessionStatus;
export type SessionStatus = Api.SessionStatus;
export type Snapshot = Api.Snapshot;
export type ApiToken = Api.Token;
export type TenantsPage = Api.TenantPage;
export type UsersPage = Api.UserPage;
export type SessionsPage = Api.SessionPage;
export type SessionsBulkResponse = Api.SessionBulkResponse;
export type SnapshotsPage = Api.SnapshotPage;
export type TokensPage = Api.TokenPage;
export type BrowserChannel = Api.BrowserChannel;
export type BrowserChannelsResponse = Api.BrowserChannels;
export type ResourceEvent = Api.Event;
export type EventsPage = Api.EventPage;
export type CreateSessionResponse = Api.CreateSessionResult;
export type SessionMutationResponse = Api.SessionMutation;
export type SnapshotMutationResponse = Api.SnapshotMutation;
export type PromoteSessionResponse = Api.SnapshotMutation;
export type CreateTokenResponse = Api.CreateTokenResponse;
export type Health = Api.Health;
