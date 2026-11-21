import { freePort, run } from "@aperture-browser/e2e/src/process.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Control } from "./control.ts";

export interface ProxyService {
  /** Where the proxy listens: the one address a browser knows. */
  readonly url: string;
  readonly said: () => string;
}

/**
 * A Traefik before the control plane and its nodes, which reads its routes from the
 * control plane as a deployment's does. The program is the dev shell's.
 */
export const start = Effect.gen(function* () {
  const control = yield* Control;
  const port = yield* freePort;
  const traefik = yield* run("traefik", [
    `--entryPoints.web.address=127.0.0.1:${port}`,
    `--providers.http.endpoint=${control.url}/api/control/route/traefik`,
    `--providers.http.headers.Authorization=Bearer ${control.bootstrapToken}`,
    // A node that registers is routed to this soon after.
    "--providers.http.pollInterval=1s",
    "--global.checkNewVersion=false",
    "--global.sendAnonymousUsage=false",
  ]);
  yield* Effect.addFinalizer(() => traefik.ends("SIGTERM"));
  return { url: `http://127.0.0.1:${port}`, said: traefik.said } satisfies ProxyService;
});

export class Proxy extends Context.Service<Proxy, ProxyService>()(
  "@aperture-browser/control/tests/Proxy",
) {}

export const layer = Layer.effect(Proxy, start);
