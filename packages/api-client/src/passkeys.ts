import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { AuthApi } from "./auth/service.ts";

/** The browser's WebAuthn ceremony was cancelled, timed out, or is unsupported. */
export class PasskeyCeremonyError extends Schema.TaggedError<PasskeyCeremonyError>()(
  "PasskeyCeremonyError",
  {
    ceremony: Schema.Literals(["authentication", "registration"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Signs the browser in with a passkey, establishing the web session. */
export const loginWithPasskey = Effect.fn("loginWithPasskey")(function* () {
  const auth = yield* AuthApi;
  const options = yield* auth.beginPasskeyLogin();
  const credential = yield* Effect.tryPromise({
    try: () => startAuthentication({ optionsJSON: options.publicKey }),
    catch: (cause) =>
      new PasskeyCeremonyError({
        ceremony: "authentication",
        message: "Passkey sign-in was cancelled or failed",
        cause,
      }),
  });
  yield* auth.finishPasskeyLogin(credential);
});

/** Creates a passkey on this device and registers it for the signed-in user. */
export const registerPasskey = Effect.fn("registerPasskey")(function* (name: string) {
  const auth = yield* AuthApi;
  const options = yield* auth.beginPasskeyRegistration(name);
  const credential = yield* Effect.tryPromise({
    try: () => startRegistration({ optionsJSON: options.publicKey }),
    catch: (cause) =>
      new PasskeyCeremonyError({
        ceremony: "registration",
        message: "Passkey registration was cancelled or failed",
        cause,
      }),
  });
  return yield* auth.finishPasskeyRegistration(credential);
});
