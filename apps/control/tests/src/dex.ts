import { directory, freePort, run } from "@aperture-browser/e2e/src/process.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Control } from "./control.ts";
import { Proxy } from "./proxy.ts";

/** What the control plane knows the provider by. */
export const PROVIDER = "dex";
export const PROVIDER_NAME = "Dex";
/** What an admin may come to know it by as well, once the control plane runs. */
export const ADDED = ["added", "another"] as const;
/** Everyone's password there. */
export const PASSWORD = "password";
/** That password as Dex keeps it: the digest its own documentation gives for it. */
const PASSWORD_HASH = "$2a$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W";

/** The people whose addresses the provider says it verified: they sign in at `local`. */
export const VERIFIED = [
  { email: "ada@example.test", name: "Ada" },
  { email: "bob@example.test", name: "Bob" },
  { email: "carol@elsewhere.test", name: "Carol" },
] as const;

/** Those whose addresses it does not say it verified: they sign in at `unverified`. */
export const UNVERIFIED = ["eve@example.test", "mallory@example.test"] as const;

/** Which of the provider's ways someone signs in by, as its addresses name them. */
export type Connector = "local" | "unverified";

export interface AddressService {
  /** The provider's issuer, where it is once it has started. */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly port: number;
  readonly upstreamPort: number;
}

/**
 * Where the provider is going to be: the control plane is told before it starts, and the
 * provider starts after it, since each names the other's address.
 */
export class Address extends Context.Service<Address, AddressService>()(
  "@aperture-browser/control/tests/DexAddress",
) {}

export const address = Layer.effect(
  Address,
  Effect.gen(function* () {
    const port = yield* freePort;
    return {
      issuer: `http://127.0.0.1:${port}/dex`,
      clientId: "aperture",
      clientSecret: "the-secret-of-the-checks-client",
      port,
      upstreamPort: yield* freePort,
    };
  }),
);

const people = (all: ReadonlyArray<{ readonly email: string; readonly name: string }>) =>
  all.map(({ email, name }) => ({ email, username: name, userID: email, hash: PASSWORD_HASH }));

/** One Dex, on what its configuration says, once it tells how it is reached. */
const serve = Effect.fn("Dex.serve")(function* (dir: string, name: string, config: object) {
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const file = `${dir}/${name}.json`;
  // JSON is YAML, which is what it reads.
  yield* fs.writeFileString(
    file,
    JSON.stringify({
      storage: { type: "memory" },
      oauth2: { skipApprovalScreen: true },
      enablePasswordDB: true,
      ...config,
    }),
  );
  const dex = yield* run("dex", ["serve", file]);
  yield* Effect.addFinalizer(() => dex.ends("SIGTERM"));
  const issuer = "issuer" in config && typeof config.issuer === "string" ? config.issuer : "";
  yield* until(
    `the provider ${name} telling how it is reached`,
    http
      .get(`${issuer}/.well-known/openid-configuration`)
      .pipe(Effect.map((answer) => answer.status === 200)),
    "30 seconds",
  );
});

/**
 * A real OpenID Connect provider for as long as the scope lasts: Dex, the dev shell's,
 * with people of its own. A second one stands behind it for those whose addresses it does
 * not vouch for: Dex says of its own people that their addresses are verified, and of
 * those another provider sends it only what that one said, which here is nothing.
 */
export const start = Effect.gen(function* () {
  const at = yield* Address;
  const control = yield* Control;
  const proxy = yield* Effect.serviceOption(Proxy);
  const dir = yield* directory;
  const upstream = `http://127.0.0.1:${at.upstreamPort}/dex`;
  const callback = `${at.issuer}/callback`;

  yield* serve(dir, "upstream", {
    issuer: upstream,
    web: { http: `127.0.0.1:${at.upstreamPort}` },
    // Their names are their addresses: the name is what the provider before it reads.
    staticPasswords: people(UNVERIFIED.map((email) => ({ email, name: email }))),
    staticClients: [{ id: "dex", secret: "upstream", name: "Dex", redirectURIs: [callback] }],
  });
  yield* serve(dir, "provider", {
    issuer: at.issuer,
    web: { http: `127.0.0.1:${at.port}` },
    staticPasswords: people(VERIFIED),
    staticClients: [
      {
        id: at.clientId,
        secret: at.clientSecret,
        name: "Aperture",
        // People come to the control plane itself, or through the proxy before it.
        redirectURIs: [control.url, ...Option.toArray(proxy).map((one) => one.url)].flatMap(
          (origin) => [PROVIDER, ...ADDED].map((id) => `${origin}/api/auth/callback/${id}`),
        ),
      },
    ],
    connectors: [
      {
        type: "oidc",
        id: "unverified",
        name: "Unverified",
        config: {
          issuer: upstream,
          clientID: "dex",
          clientSecret: "upstream",
          redirectURI: callback,
          // No `email`: the address is read from the name, and nothing says it is verified.
          scopes: ["profile"],
          claimMapping: { email: "name" },
        },
      },
    ],
  });
});

/** The provider the suite's control plane was told of, started once that is there. */
export const layer = Layer.effectDiscard(start);
