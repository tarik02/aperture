import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Accounts } from "./service.ts";

/**
 * Tells in the log, when the control plane starts and nobody is a person yet, where the
 * first admin is made. A warning, which stands out among the lines of what is answered:
 * until someone follows the link, nobody signs in.
 */
export const announceFirstAdmin = Effect.fn("FirstAdmin.announce")(function* () {
  const accounts = yield* Accounts;
  const link = yield* accounts.firstAdminLink();
  if (Option.isSome(link)) {
    yield* Effect.logWarning(`Setup link: ${link.value}`);
  }
});

export const layer = Layer.effectDiscard(announceFirstAdmin());
