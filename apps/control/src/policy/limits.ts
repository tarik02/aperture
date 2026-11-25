import type { LimitsInit } from "@aperture-browser/executor-client";
import type { Effective } from "./service.ts";

/**
 * The limits a session's node holds it to, as its settings come to: what no level says is
 * left out, for the node's own, and never is zero, which is none whatever the node has.
 */
export const limitsOf = (effective: Effective): LimitsInit => {
  const idle = effective.suspendIdleAfter;
  const seconds = idle.source === "node" ? undefined : Number(idle.value ?? 0);
  return seconds === undefined ? {} : { suspendIdleAfter: { seconds: BigInt(seconds) } };
};

/**
 * Whether a node holds a session to the limits it is to be held to, as the node tells the
 * session's: its own where it has them, the node's where not, and none left out.
 */
export const holds = (
  told: { readonly suspendIdleAfter?: { readonly seconds: bigint } | undefined } | undefined,
  wanted: LimitsInit,
  /** What the node holds a session to that has none of its own. */
  own: { readonly suspendIdleAfterSeconds?: number | undefined } | undefined,
) => {
  const asked = wanted.suspendIdleAfter?.seconds;
  const fallback = own?.suspendIdleAfterSeconds;
  const expected =
    asked === undefined
      ? fallback === undefined || fallback === 0
        ? undefined
        : BigInt(fallback)
      : asked === 0n
        ? undefined
        : asked;
  return told?.suspendIdleAfter?.seconds === expected;
};
