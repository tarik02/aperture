import type { Caller, EventActor } from "@aperture-browser/control-api";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { SYSTEM } from "./schemas.ts";

/** Who does what is being done, and where their request came from. */
export interface DoerShape {
  readonly actor: EventActor;
  readonly address: string | null;
}

/**
 * Who does what the fiber does, for the events that are recorded of it. Whatever takes
 * requests says who each comes from; what the control plane does by itself is the
 * system's.
 */
export const Doer = Context.Reference<DoerShape>("@aperture-browser/control/Doer", {
  defaultValue: () => ({ actor: SYSTEM, address: null }),
});

/** The actor a caller is: its account, or the holder of the bootstrap token. */
export const actorOf = (caller: Caller): EventActor =>
  Option.match(caller.account, {
    onNone: () => ({ kind: "bootstrap", id: null, name: null }),
    onSome: (account) => ({ kind: "account", id: account.id, name: account.name }),
  });
