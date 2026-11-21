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
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import type * as SqlClient from "effect/sql/SqlClient";
import * as App from "../../src/app.ts";
import * as Server from "../../src/server.ts";
import * as Settings from "../../src/settings/layer.ts";
import * as Postgres from "./postgres.ts";

/** Where a control plane keeps what it knows: a database of its own, or nothing but memory. */
export const STORES = ["postgres", "memory"] as const;

export interface ControlOptions {
  /** A PostgreSQL database of its own, unless it says memory. */
  readonly stores?: (typeof STORES)[number];
  /** How long a node may be silent before it is not used; the program's own choice without. */
  readonly nodeSilentAfter?: string;
  /** Serve the console as it was built, beside the API. */
  readonly console?: boolean;
  /** Hold signing in to so many tries a while from one address, as a deployment does. */
  readonly rateLimit?: boolean;
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
const PEM_LINE = 64;
const CONSOLE = new URL("../../../console/dist", import.meta.url).pathname;
const MASTER_KEY_BYTES = 32;

const pem = (what: string, key: ArrayBuffer) => {
  const lines = Base64.encode(new Uint8Array(key)).match(new RegExp(`.{1,${PEM_LINE}}`, "gu"));
  return `-----BEGIN ${what}-----\n${(lines ?? []).join("\n")}\n-----END ${what}-----\n`;
};

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
  readonly bootstrapToken: string;
  /** The public key its tickets are checked against, as PEM: what an executor is given. */
  readonly ticketKey: string;
  /** Its database, for what a check looks up there itself; none for one that keeps to memory. */
  readonly sql: Option.Option<SqlClient.SqlClient>;
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

export const KEEPALIVE = "/aperture.control.v1.NodeService/Keepalive";

export const start = Effect.fn("Control.start")(function* (options: ControlOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const http = yield* Effect.context<HttpClient.HttpClient>();
  const postgres = options.stores === "memory" ? undefined : yield* Postgres.start;
  const dir = yield* directory;

  // Effect signs nothing: the keys are the platform's own, which makes them or throws.
  const keys = yield* Effect.promise(() =>
    crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
  );
  const ticketKey = `${dir}/ticket.pub.pem`;
  const signingKey = `${dir}/ticket.pem`;
  yield* fs.writeFileString(
    ticketKey,
    pem("PUBLIC KEY", yield* Effect.promise(() => crypto.subtle.exportKey("spki", keys.publicKey))),
  );
  yield* fs.writeFileString(
    signingKey,
    pem(
      "PRIVATE KEY",
      yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", keys.privateKey)),
    ),
  );

  const masterKey = `${dir}/master.key`;
  yield* fs.writeFileString(
    masterKey,
    Base64.encode(crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES))),
  );

  // Its own address is what it tells a proxy to ask it at.
  const port = yield* freePort;
  const environment = ConfigProvider.fromEnvRecord({
    APERTURE_CONTROL_LISTEN_PORT: String(port),
    APERTURE_CONTROL_MASTER_KEY: masterKey,
    // Checks sign in more often from one address than anyone is let.
    APERTURE_CONTROL_RATE_LIMIT: String(options.rateLimit ?? false),
    APERTURE_CONTROL_DATABASE_URL: postgres?.url ?? "postgres://nowhere",
    APERTURE_CONTROL_BOOTSTRAP_TOKEN: BOOTSTRAP,
    APERTURE_CONTROL_TICKET_KEY: signingKey,
    ...(options.console === true ? { APERTURE_CONTROL_CONSOLE_DIR: CONSOLE } : {}),
    ...(options.nodeSilentAfter === undefined
      ? {}
      : { APERTURE_CONTROL_NODE_SILENT_AFTER: options.nodeSilentAfter }),
  });
  const running = yield* Layer.build(
    (postgres === undefined ? App.layerTest : App.layer).pipe(
      Layer.provideMerge(Server.listen({ host: "127.0.0.1", port })),
      Layer.provide(Settings.layer),
      Layer.provide(ConfigProvider.layer(environment)),
      // Every request it answers is a line otherwise.
      Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
    ),
  );
  const address = Context.get(running, HttpServer.HttpServer).address;
  const url = address._tag === "UnixPathAddress" ? "" : `http://127.0.0.1:${address.port}`;

  const sql =
    postgres === undefined
      ? Option.none()
      : Option.some(
          Context.get(
            yield* Layer.build(PgClient.layer({ url: Redacted.make(postgres.url) })),
            PgClient.PgClient,
          ),
        );

  return {
    url,
    bootstrapToken: BOOTSTRAP,
    ticketKey,
    sql,
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
    payload: { name: "checks" },
  });
  return { account: made, token: token.token, api: yield* control.as(token.token) };
});
