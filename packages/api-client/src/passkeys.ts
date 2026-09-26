import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { AuthApi } from "./auth/service.ts";

const PasskeyCeremony = Schema.Literals(["authentication", "registration"]);
type PasskeyCeremony = typeof PasskeyCeremony.Type;

/**
 * The browser did not complete the WebAuthn ceremony. `cancelled` covers the user
 * dismissing the prompt or letting it time out; anything else is `failed`.
 */
export class PasskeyCeremonyError extends Schema.TaggedError<PasskeyCeremonyError>()(
  "PasskeyCeremonyError",
  {
    ceremony: PasskeyCeremony,
    reason: Schema.Literals(["cancelled", "failed"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const ceremonyLabels = {
  authentication: "Passkey sign-in",
  registration: "Passkey registration",
} satisfies Record<PasskeyCeremony, string>;

// Browsers report a dismissed or timed-out prompt as NotAllowedError, and an aborted one as
// AbortError; @simplewebauthn/browser keeps that name on the WebAuthnError it rethrows.
const toCeremonyError = (ceremony: PasskeyCeremony) => (cause: unknown) => {
  const cancelled =
    cause instanceof Error && (cause.name === "NotAllowedError" || cause.name === "AbortError");
  const label = ceremonyLabels[ceremony];
  return new PasskeyCeremonyError({
    ceremony,
    reason: cancelled ? "cancelled" : "failed",
    message: cancelled ? `${label} was cancelled` : `${label} failed`,
    cause,
  });
};

/** Signs the browser in with a passkey, establishing the web session. */
export const loginWithPasskey = Effect.fn("loginWithPasskey")(function* () {
  const auth = yield* AuthApi;
  const options = yield* auth.beginPasskeyLogin();
  const credential = yield* Effect.tryPromise({
    try: () => startAuthentication({ optionsJSON: options.publicKey }),
    catch: toCeremonyError("authentication"),
  });
  yield* auth.finishPasskeyLogin(credential);
});

/** Creates a passkey on this device and registers it for the signed-in user. */
export const registerPasskey = Effect.fn("registerPasskey")(function* (name: string) {
  const auth = yield* AuthApi;
  const options = yield* auth.beginPasskeyRegistration(name);
  const credential = yield* Effect.tryPromise({
    try: () => startRegistration({ optionsJSON: options.publicKey }),
    catch: toCeremonyError("registration"),
  });
  return yield* auth.finishPasskeyRegistration(credential);
});
