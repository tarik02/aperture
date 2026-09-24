import { Schema } from "effect";

// The browser login flows are not part of api/openapi.yaml.

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

export type LoginMethods = typeof LoginMethods.Type;
export type PasskeyLoginOptions = typeof PasskeyLoginOptions.Type;
export type PasskeyRegistrationOptions = typeof PasskeyRegistrationOptions.Type;
export type Passkey = typeof Passkey.Type;
export type Passkeys = typeof Passkeys.Type;
export type PasskeyMutation = typeof PasskeyMutation.Type;
export type PasswordLoginResponse = typeof PasswordLoginResponse.Type;
export type RecoveryCodes = typeof RecoveryCodes.Type;
export type SecurityStatus = typeof SecurityStatus.Type;
export type TOTPEnrollment = typeof TOTPEnrollment.Type;
