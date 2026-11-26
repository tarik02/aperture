import { Api } from "@aperture-browser/control-api";
import { type Answer, request } from "@aperture-browser/e2e/src/http.ts";
import { directory, freePort } from "@aperture-browser/e2e/src/process.ts";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import type * as SqlClient from "effect/sql/SqlClient";
import { exportPKCS8, exportSPKI } from "jose";
import * as App from "../../src/app.ts";
import * as Server from "../../src/server.ts";
import * as Settings from "../../src/settings/layer.ts";
import * as Dex from "./dex.ts";
import * as Postgres from "./postgres.ts";

export interface ControlOptions {
  /** How long a node may be silent before it is not used; the program's own choice without. */
  readonly nodeSilentAfter?: string;
  /** Serve the console as it was built, beside the API. */
  readonly console?: boolean;
  /** Hold signing in to so many tries a while from one address, as a deployment does. */
  readonly rateLimit?: boolean;
  /** Where people reach it from outside, as a deployment that has a name says. */
  readonly publicUrl?: string;
  /** The proxies whose word is taken for where a request came from. */
  readonly trustedProxies?: string;
  /**
   * Sign people in through the suite's provider, whose address is given beside this. With
   * `provision`, whoever it vouches for is made a person; of `domains` alone, where named.
   */
  readonly sso?: {
    readonly provision?: boolean;
    readonly domains?: ReadonlyArray<string>;
    /** The settings name no provider: the suite's is there for an admin to add. */
    readonly unnamed?: boolean;
  };
  /**
   * Another control plane whose database and keys this one has: a second program of one
   * deployment, or the same one started again.
   */
  readonly beside?: ControlService;
  /** Serve Prometheus metrics on an address of their own. */
  readonly metrics?: boolean;
}

/** What a node says of itself in a keepalive, as JSON has it. */
export interface Keepalive {
  readonly registrationToken: string;
  readonly name: string;
  readonly internalUrl: string;
  readonly balancerUrl?: string;
  readonly publicUrl?: string;
  readonly operatorToken: string;
}

const BOOTSTRAP = "bootstrap-token-of-the-checks";
const CONSOLE = new URL("../../../console/dist", import.meta.url).pathname;
const MASTER_KEY_BYTES = 32;

const client = (url: string, token: string) =>
  HttpApiClient.make(Api, {
    baseUrl: url,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
  });

/** The control plane's API as a caller with one token has it. */
export type Client = Effect.Success<ReturnType<typeof client>>;

/** A control plane on a database of its own, as `main.ts` runs it. */
export interface ControlService {
  readonly url: string;
  /** Where its metrics are, where it serves them. */
  readonly metricsUrl: string | undefined;
  readonly bootstrapToken: string;
  /** What it was started with, as its environment: for a program that is run beside it. */
  readonly settings: Readonly<Record<string, string>>;
  /** The public key its tickets are checked against, as PEM: what an executor is given. */
  readonly ticketKey: string;
  /** Its database, for what a check looks up there itself. */
  readonly sql: SqlClient.SqlClient;
  /** The server its database is on, for a check of what becomes of it without one. */
  readonly database: Postgres.PostgresService;
  /** What it warned of since it started, each as the line's message. */
  readonly warned: () => ReadonlyArray<string>;
  /** Its API for whoever holds the token. */
  readonly as: (token: string) => Effect.Effect<Client>;
  /** A request whose answer is told whatever its status. */
  readonly request: (
    token: string,
    method: HttpMethod.HttpMethod,
    path: string,
    body?: unknown,
  ) => Effect.Effect<Answer, HttpClientError.HttpClientError>;
  /** A node's keepalive, as JSON. */
  readonly keepalive: (said: Keepalive) => Effect.Effect<Answer, HttpClientError.HttpClientError>;
}

/** Every scope: writing something includes reading it. */
export const ALL_SCOPES = [
  "sessions:write",
  "snapshots:write",
  "workspaces:write",
  "tokens:write",
  "events:read",
  "admin",
] as const;

export const KEEPALIVE = "/aperture.control.v1.NodeService/Keepalive";

export const start = Effect.fn("Control.start")(function* (options: ControlOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const http = yield* Effect.context<HttpClient.HttpClient>();
  const dir = yield* directory;

  // Effect signs nothing: the keys are the platform's own, which makes them or throws.
  const keys = yield* Effect.promise(() =>
    crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
  );
  const ticketKey = options.beside?.ticketKey ?? `${dir}/ticket.pub.pem`;
  const signingKey = `${dir}/ticket.pem`;
  const masterKey = `${dir}/master.key`;
  if (options.beside === undefined) {
    yield* fs.writeFileString(ticketKey, yield* Effect.promise(() => exportSPKI(keys.publicKey)));
    yield* fs.writeFileString(
      signingKey,
      yield* Effect.promise(() => exportPKCS8(keys.privateKey)),
    );
    yield* fs.writeFileString(
      masterKey,
      Base64.encode(crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES))),
    );
  }
  const database = options.beside?.database ?? (yield* Postgres.start);
  const shared =
    options.beside === undefined
      ? {
          APERTURE_CONTROL_MASTER_KEY: masterKey,
          APERTURE_CONTROL_DATABASE_URL: database.url,
          APERTURE_CONTROL_TICKET_KEY: signingKey,
        }
      : {
          APERTURE_CONTROL_MASTER_KEY: options.beside.settings["APERTURE_CONTROL_MASTER_KEY"] ?? "",
          APERTURE_CONTROL_DATABASE_URL:
            options.beside.settings["APERTURE_CONTROL_DATABASE_URL"] ?? "",
          APERTURE_CONTROL_TICKET_KEY: options.beside.settings["APERTURE_CONTROL_TICKET_KEY"] ?? "",
        };

  const provider =
    options.sso === undefined ? Option.none() : yield* Effect.serviceOption(Dex.Address);
  const clientSecret = `${dir}/provider.secret`;
  if (Option.isSome(provider)) {
    yield* fs.writeFileString(clientSecret, `${provider.value.clientSecret}\n`);
  }

  // Its own address is what it tells a proxy to ask it at.
  const port = yield* freePort;
  const metricsPort = options.metrics === true ? yield* freePort : undefined;
  const settings: Record<string, string> = {
    APERTURE_CONTROL_LISTEN_PORT: String(port),
    ...(metricsPort === undefined
      ? {}
      : { APERTURE_CONTROL_METRICS_LISTEN: `127.0.0.1:${metricsPort}` }),
    ...shared,
    // Checks sign in more often from one address than anyone is let.
    APERTURE_CONTROL_RATE_LIMIT: String(options.rateLimit ?? false),
    APERTURE_CONTROL_BOOTSTRAP_TOKEN: BOOTSTRAP,
    ...(options.console === true ? { APERTURE_CONTROL_CONSOLE_DIR: CONSOLE } : {}),
    // The suite's provider is on this machine, and speaks no TLS.
    ...(Option.isNone(provider) ? {} : { APERTURE_CONTROL_SSO_LOOPBACK_HTTP: "true" }),
    ...(Option.isNone(provider) || options.sso?.unnamed === true
      ? {}
      : {
          APERTURE_CONTROL_SSO_PROVIDERS: JSON.stringify([
            {
              id: Dex.PROVIDER,
              name: Dex.PROVIDER_NAME,
              issuer: provider.value.issuer,
              clientId: provider.value.clientId,
              clientSecretFile: clientSecret,
            },
          ]),
          APERTURE_CONTROL_SSO_PROVISION: String(options.sso?.provision ?? false),
          APERTURE_CONTROL_SSO_DOMAINS: (options.sso?.domains ?? []).join(","),
        }),
    ...(options.publicUrl === undefined ? {} : { APERTURE_CONTROL_PUBLIC_URL: options.publicUrl }),
    ...(options.trustedProxies === undefined
      ? {}
      : { APERTURE_CONTROL_TRUSTED_PROXIES: options.trustedProxies }),
    ...(options.nodeSilentAfter === undefined
      ? {}
      : { APERTURE_CONTROL_NODE_SILENT_AFTER: options.nodeSilentAfter }),
  };
  const environment = ConfigProvider.fromEnvRecord(settings);
  const warned: Array<string> = [];
  const heard = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") {
      warned.push([message].flat().map(String).join(" "));
    }
  });
  const running = yield* Layer.build(
    App.layer.pipe(
      Layer.provideMerge(Server.listen({ host: "127.0.0.1", port })),
      Layer.provide(Settings.layer),
      Layer.provide(ConfigProvider.layer(environment)),
      // Every request it answers is a line otherwise.
      Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
      Layer.provide(Logger.layer([heard], { mergeWithExisting: true })),
    ),
  );
  const address = Context.get(running, HttpServer.HttpServer).address;
  const url = address._tag === "UnixPathAddress" ? "" : `http://127.0.0.1:${address.port}`;

  const sql = Context.get(
    yield* Layer.build(
      PgClient.layer({ url: Redacted.make(shared.APERTURE_CONTROL_DATABASE_URL) }),
    ),
    PgClient.PgClient,
  );

  return {
    url,
    metricsUrl: metricsPort === undefined ? undefined : `http://127.0.0.1:${metricsPort}/metrics`,
    bootstrapToken: BOOTSTRAP,
    settings,
    ticketKey,
    sql,
    database,
    warned: () => [...warned],
    as: (token) => client(url, token).pipe(Effect.provide(http)),
    request: (token, method, path, body) =>
      request(url, token, method, path, body).pipe(Effect.provide(http)),
    keepalive: (said) => request(url, "", "POST", KEEPALIVE, said).pipe(Effect.provide(http)),
  } satisfies ControlService;
});

export class Control extends Context.Service<Control, ControlService>()(
  "@aperture-browser/control/tests/Control",
) {}

/** One control plane for all the checks of a suite. */
export const layer = (options: ControlOptions = {}) => Layer.effect(Control, start(options));

/** An account and an API token of it, made by whoever holds the bootstrap token. */
export const account = Effect.fn("Control.account")(function* (name: string, admin = false) {
  const control = yield* Control;
  const bootstrap = yield* control.as(control.bootstrapToken);
  const made = yield* bootstrap.accounts.create({ payload: { name, admin } });
  const token = yield* bootstrap.accounts.createToken({
    params: { id: made.id },
    // All there is: what the account does is what the checks are of.
    payload: { name: "checks", scopes: ALL_SCOPES },
  });
  return { account: made, token: token.token, api: yield* control.as(token.token) };
});
