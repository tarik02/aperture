import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { SmokeFailed } from "../errors.ts";
import { Programs } from "../programs/service.ts";
import { loadedImage } from "./image.ts";
import { answer, Targets, until } from "./session.ts";

const PROJECT = "aperture-smoke";
const VERSION = "smoke";
const PARTS = ["keys", "postgres", "control", "node", "proxy"];

const Nodes = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ alive: Schema.Boolean, offers: Schema.optional(Schema.Unknown) })),
);
const Account = Schema.fromJsonString(Schema.Struct({ id: Schema.String }));
const Token = Schema.fromJsonString(Schema.Struct({ token: Schema.String }));
const Session = Schema.fromJsonString(Schema.Struct({ path: Schema.String }));

/**
 * Brings deploy/compose.yaml up with Docker as docs/install.md tells its users to, on the
 * images given, and asks it from outside what they would: the console is served, the node
 * registered, and a session an account makes shows a tab.
 */
export const compose = Effect.fn("smoke.compose")(function* (
  control: string,
  node: string,
  port: number,
) {
  const path = yield* Path.Path;
  const programs = yield* Programs;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const url = `http://127.0.0.1:${port}`;
  const api = `${url}/api/control`;

  const env = {
    APERTURE_VERSION: VERSION,
    APERTURE_URL: url,
    APERTURE_LISTEN: `127.0.0.1:${port}`,
  };
  const file = path.resolve("deploy", "compose.yaml");
  const composed = (args: readonly string[], quiet = false) =>
    programs.run("docker", ["compose", "--project-name", PROJECT, "--file", file, ...args], {
      env,
      quiet,
    });

  for (const [part, archive] of [
    ["control", control],
    ["node", node],
  ] as const) {
    const loaded = yield* loadedImage(
      yield* programs.read("docker", ["load", "--input", archive]),
      archive,
    );
    yield* programs.run("docker", ["tag", loaded, `ghcr.io/tarik02/aperture-${part}:${VERSION}`]);
  }

  const shown = Effect.gen(function* () {
    yield* Effect.ignore(composed(["ps", "--all"]));
    for (const part of PARTS) {
      yield* Effect.ignore(composed(["logs", "--tail", "40", part]));
    }
  });

  const call = (token: string, method: HttpMethod.HttpMethod, at: string, body: object) =>
    client
      .execute(
        HttpClientRequest.make(method)(`${api}${at}`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.text),
        Effect.timeout("30 seconds"),
        Effect.mapError(
          (error) => new SmokeFailed({ reason: `${method} ${at}: ${error.message}` }),
        ),
      );

  yield* Effect.gen(function* () {
    yield* composed(["up", "--detach", "--wait", "--wait-timeout", "300"]);

    // No image of the deployment has a shell to read the token with.
    const bootstrap = (yield* programs.read("docker", [
      "run",
      "--rm",
      "--volume",
      `${PROJECT}_keys:/keys:ro`,
      "busybox",
      "cat",
      "/keys/bootstrap-token",
    ])).replace(/\n+$/u, "");

    const page = yield* answer(`${url}/`, undefined, 10).pipe(
      Effect.mapError((error) => new SmokeFailed({ reason: `the console: ${error.message}` })),
    );
    if (!page.includes("<title>Aperture</title>")) {
      return yield* new SmokeFailed({ reason: "the console is not served" });
    }

    yield* until(
      "no node registered",
      120,
      answer(`${api}/nodes`, bootstrap, 5).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Nodes)),
        Effect.map(([first]) => first !== undefined && first.alive && first.offers != null),
      ),
    );

    const account = yield* call(bootstrap, "POST", "/accounts", { name: "ops" }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Account)),
    );
    const { token } = yield* call(
      bootstrap,
      "POST",
      `/accounts/${encodeURIComponent(account.id)}/tokens`,
      {
        name: "check",
        scopes: ["sessions:write"],
      },
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Token)));
    const session = yield* call(token, "POST", "/sessions", {}).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Session)),
    );
    yield* until(
      "the session told of no tab",
      120,
      answer(`${url}${session.path}/targets`, token, 5).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Targets)),
        Effect.map((tabs) => tabs.length >= 1),
      ),
    );
  }).pipe(
    Effect.tapError(() => shown),
    Effect.ensuring(Effect.ignore(composed(["down", "--volumes"], true))),
  );

  yield* Console.log("the console is served, the node registered, and a session shows a tab");
});
