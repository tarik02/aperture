import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as PrometheusMetrics from "effect/observability/PrometheusMetrics";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { Nodes } from "./nodes/service.ts";
import * as Server from "./server.ts";
import { SessionsStore } from "./sessions/store.ts";
import { Settings } from "./settings/service.ts";
import { version } from "./version.ts";

/** As v1 had them, from a request answered at once to one a node takes long over. */
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
/** What a reason a sign-in was refused for may be as a label: a code, and never what was sent. */
const REASON = /^[a-z0-9_]{1,64}$/u;
const NOT_FOUND = 404;
const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const httpRequests = Metric.counter("aperture_http_requests_total", {
  description: "HTTP requests the control plane answered, by route template",
  incremental: true,
});
const httpDuration = Metric.histogram("aperture_http_request_duration_seconds", {
  description: "How long the control plane took to answer an HTTP request, by route template",
  boundaries: HTTP_BUCKETS,
});
const sessionRequests = Metric.counter("aperture_control_session_requests_total", {
  description: "What the control plane was asked to do with sessions, by what came of it",
  incremental: true,
});
const toolCalls = Metric.counter("aperture_mcp_tool_calls_total", {
  description: "Tools called over MCP, by what came of the call",
  incremental: true,
});
const logins = Metric.counter("aperture_auth_logins_total", {
  description: "People who signed in, by how",
  incremental: true,
});
const loginFailures = Metric.counter("aperture_auth_failures_total", {
  description: "Sign-ins that were refused, by how they were tried and why",
  incremental: true,
});

const count = (metric: Metric.Counter<number>, attributes: Record<string, string>) =>
  Metric.update(Metric.withAttributes(metric, attributes), 1);

/**
 * Counts every request the router answers by the route it matched, which is a template
 * such as `/api/control/sessions/:id`: an address itself would be a series of its own.
 * Added last of what the router is given, it runs nearest the route, where the route that
 * matched is still known.
 */
export const httpLayer = HttpRouter.middleware(
  (handled) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const [took, exit] = yield* Effect.timed(Effect.exit(handled));
      const matched = yield* Effect.serviceOption(HttpRouter.RouteContext);
      const route = Option.match(matched, {
        onNone: () => "unmatched",
        onSome: (context) => context.route.path,
      });
      const method = METHODS.has(request.method) ? request.method : "other";
      const status = HttpServerError.exitResponse(exit).status;
      yield* count(httpRequests, {
        route,
        method,
        status_class: `${Math.floor(status / 100)}xx`,
      });
      yield* Metric.update(
        Metric.withAttributes(httpDuration, { route, method }),
        Duration.toSeconds(took),
      );
      return yield* exit;
    }),
  { global: true },
);

/** The errors of a node, or of there being none: what is not the caller's doing. */
const NODE_FAILURES = ["NoNode", "NodeRefused", "NodeUnreachable"] as const;

/** What came of what was asked of a session: the node's failures apart from the caller's. */
const outcomeOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) {
    return "ok";
  }
  return Option.match(Cause.findErrorOption(exit.cause), {
    onNone: () => "failed",
    onSome: (error) =>
      NODE_FAILURES.some((tag) => Predicate.isTagged(error, tag)) ? "failed" : "refused",
  });
};

/** Counts what was asked of sessions, as `create` or `resume`, as it ends. */
export const sessionRequest =
  (action: "create" | "resume" | "suspend" | "delete") =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.onExit(self, (exit) => count(sessionRequests, { action, outcome: outcomeOf(exit) }));

/** Counts a call of an MCP tool as it ends: one whose result says it failed as an error. */
export const toolCall =
  (tool: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.onExit(self, (exit) =>
      count(toolCalls, {
        tool,
        outcome: Exit.isSuccess(exit)
          ? (exit.value as { readonly isError?: boolean }).isError === true
            ? "error"
            : "ok"
          : "failed",
      }),
    );

export const signedIn = (method: string) => count(logins, { method });

export const refusedSignIn = (method: string, reason: string) =>
  count(loginFailures, { method, reason: REASON.test(reason) ? reason : "other" });

const escaped = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

/** A gauge as the exposition format has it, with a line for each of its series. */
const gauge = (
  name: string,
  help: string,
  series: ReadonlyArray<readonly [Record<string, string>, number]>,
) => {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const [labels, value] of series) {
    const named = Object.entries(labels).map(([key, label]) => `${key}="${escaped(label)}"`);
    lines.push(`${name}${named.length === 0 ? "" : `{${named.join(",")}}`} ${value}`);
  }
  return lines.join("\n");
};

/** What there is, read each time it is asked: the sessions and the nodes. */
const observed = Effect.gen(function* () {
  const store = yield* SessionsStore;
  const nodes = yield* Nodes;
  const settings = yield* Settings;
  const build = gauge(
    "aperture_build_info",
    "The build of the control plane that serves the metrics; always 1",
    [[{ version, commit: Option.getOrElse(settings.commit, () => "") }, 1]],
  );
  return Effect.gen(function* () {
    const states = yield* store.countStates();
    const known = yield* nodes.list();
    return [
      gauge(
        "aperture_control_sessions",
        "Sessions by their node and their desired and observed states",
        states.map((one) => [
          {
            node: one.node ?? "",
            desired_state: one.desiredState,
            observed_state: one.observedState,
          },
          one.count,
        ]),
      ),
      gauge("aperture_control_nodes", "Nodes that ever registered", [[{}, known.length]]),
      gauge("aperture_control_nodes_silent", "Nodes that sent no keepalive for too long", [
        [{}, known.filter((one) => !one.alive).length],
      ]),
      build,
    ].join("\n");
  });
});

/** Serves the metrics at `/metrics` on an address of their own, which answers anyone. */
export const serve = (address: { readonly host: string; readonly port: number }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const read = yield* observed;
      const scrape = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (new URL(request.url, "http://metrics").pathname !== "/metrics") {
          return HttpServerResponse.empty({ status: NOT_FOUND });
        }
        const counted = yield* PrometheusMetrics.format();
        return HttpServerResponse.text(`${counted}${yield* read}\n`, { contentType: CONTENT_TYPE });
      });
      return HttpServer.serve(scrape);
    }),
  ).pipe(Layer.provide(Server.listen(address)));
