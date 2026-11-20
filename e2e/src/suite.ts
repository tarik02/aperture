import { layer } from "@effect/vitest";
import type * as Layer from "effect/Layer";

/**
 * Checks that share what `needs` gives: a session, a node, a watching browser. Its checks
 * run one after another, each on what the ones before it left, and on the real clock:
 * what they wait for takes real time.
 */
export const suite = <R, E>(needs: Layer.Layer<R, E>) =>
  layer(needs, { excludeTestServices: true, timeout: "3 minutes" });
