import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ApiCredentials } from "../authorization/service.ts";
import type { ApiRequestError } from "../errors.ts";
import type { AuthMeResponse } from "../schemas.ts";
import type * as S from "./schemas.ts";

type Call<A> = Effect.Effect<A, ApiRequestError>;

/**
 * A WebAuthn credential serialized to JSON by the browser ceremony, as
 * `@aperture-browser/api-client/passkeys` produces it. The server verifies its contents.
 */
export interface PasskeyCredentialJSON {
  readonly id: string;
  readonly rawId: string;
  readonly type: "public-key";
  readonly response: object;
  readonly clientExtensionResults: object;
}

/** Browser login, account security, and the current principal. */
export class AuthApi extends Context.Service<
  AuthApi,
  {
    readonly listLoginMethods: () => Call<S.LoginMethods>;
    readonly loginWithPassword: (email: string, password: string) => Call<S.PasswordLoginResponse>;
    readonly completePasswordMFA: (code: string) => Call<void>;
    readonly loginWithAPIToken: (token: string) => Call<void>;
    readonly beginPasskeyLogin: () => Call<S.PasskeyLoginOptions>;
    readonly finishPasskeyLogin: (credential: PasskeyCredentialJSON) => Call<void>;
    readonly acceptUserInvitation: (token: string, password: string) => Call<void>;
    readonly logoutWebSession: () => Call<void>;

    readonly getAuthMe: (
      selectedTenantId?: string | null,
      credentials?: ApiCredentials,
    ) => Call<AuthMeResponse>;

    readonly getSecurityStatus: () => Call<S.SecurityStatus>;
    readonly setPassword: (currentPassword: string, newPassword: string) => Call<void>;
    readonly listPasskeys: () => Call<S.Passkeys>;
    readonly beginPasskeyRegistration: (name: string) => Call<S.PasskeyRegistrationOptions>;
    readonly finishPasskeyRegistration: (
      credential: PasskeyCredentialJSON,
    ) => Call<S.PasskeyMutation>;
    readonly renamePasskey: (passkeyId: string, name: string) => Call<S.PasskeyMutation>;
    readonly deletePasskey: (passkeyId: string) => Call<void>;
    readonly beginTOTPEnrollment: () => Call<S.TOTPEnrollment>;
    readonly completeTOTPEnrollment: (code: string) => Call<S.RecoveryCodes>;
    readonly regenerateRecoveryCodes: (code: string) => Call<S.RecoveryCodes>;
    readonly disableTOTP: (code: string) => Call<void>;
  }
>()("@aperture-browser/api-client/AuthApi") {}
