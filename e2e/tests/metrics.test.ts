import { expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Executor from "../src/executor.ts";
import { scrape } from "../src/metrics.ts";
import { freePort } from "../src/process.ts";
import { suite } from "../src/suite.ts";

class MetricsAt extends Context.Service<MetricsAt, string>()("@aperture-browser/e2e/MetricsAt") {}

const node = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* freePort;
    return Layer.merge(
      Executor.layer({ env: { APERTURE_METRICS_LISTEN: `127.0.0.1:${port}` } }),
      Layer.succeed(MetricsAt, `http://127.0.0.1:${port}/metrics`),
    );
  }),
);

suite(node)("what a node tells Prometheus", (it) => {
  it.effect(
    "its sessions, what became of them and the node itself, as the text format has it",
    () =>
      Effect.gen(function* () {
        const executor = yield* Executor.Executor;
        const url = yield* MetricsAt;
        const session = yield* executor.client.sessions.create();

        const started = yield* scrape(url);
        expect(started.invalid).toEqual([]);
        expect(started.contentType).toContain("text/plain; version=0.0.4");
        expect(started.types).toMatchObject({
          aperture_sessions: "gauge",
          aperture_session_events_total: "counter",
          aperture_session_start_duration_seconds: "histogram",
          aperture_storage_size_bytes: "gauge",
          aperture_storage_available_bytes: "gauge",
          aperture_build_info: "gauge",
        });
        expect(started.series).toContain('aperture_sessions{status="running"} 1');
        expect(started.series).toContain('aperture_session_events_total{event="created"} 1');
        expect(started.series).toContain('aperture_session_events_total{event="started"} 1');
        expect(started.series).toContain(
          'aperture_session_start_duration_seconds_count{kind="create"} 1',
        );
        // It registers with no control plane, which it would tell of its keepalives.
        expect(Object.keys(started.types)).not.toContain("aperture_node_up");

        yield* executor.client.sessions.suspend(session.id);
        const suspended = yield* scrape(url);
        expect(suspended.series).toContain('aperture_sessions{status="suspended"} 1');
        expect(suspended.series).toContain('aperture_session_events_total{event="suspended"} 1');

        yield* executor.client.sessions.delete(session.id);
        const deleted = yield* scrape(url);
        expect(deleted.series).toContain('aperture_session_events_total{event="deleted"} 1');
        expect(deleted.series).toContain('aperture_sessions{status="suspended"} 0');
      }),
  );
});
