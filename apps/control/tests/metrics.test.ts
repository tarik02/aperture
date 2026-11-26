import { scrape } from "@aperture-browser/e2e/src/metrics.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Control from "./src/control.ts";

suite(Control.layer({ metrics: true }))("what the control plane tells Prometheus", (it) => {
  it.effect("its requests by route, its sessions and nodes, as the text format has it", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const url = control.metricsUrl ?? "";
      yield* control.request(control.bootstrapToken, "GET", "/api/control/sessions");
      const missing = yield* control.request(
        control.bootstrapToken,
        "GET",
        "/api/control/sessions/ses_nobody",
      );
      expect(missing.status).toBe(404);
      yield* control.request("", "POST", "/api/auth/sign-in/email", {
        email: "nobody@example.com",
        password: "not-a-password",
      });

      const scraped = yield* scrape(url);
      expect(scraped.invalid).toEqual([]);
      expect(scraped.contentType).toContain("text/plain; version=0.0.4");
      expect(scraped.types).toMatchObject({
        aperture_http_requests_total: "counter",
        aperture_http_request_duration_seconds: "histogram",
        aperture_auth_failures_total: "counter",
        aperture_control_sessions: "gauge",
        aperture_control_nodes: "gauge",
        aperture_control_nodes_silent: "gauge",
        aperture_build_info: "gauge",
      });
      expect(scraped.series).toContain(
        'aperture_http_requests_total{route="/api/control/sessions",method="GET",status_class="2xx"} 1',
      );
      // A route is told by its template, and never by the address that was asked.
      expect(scraped.series).toContain(
        'aperture_http_requests_total{route="/api/control/sessions/:id",method="GET",status_class="4xx"} 1',
      );
      expect(scraped.series.filter((line) => line.includes("ses_nobody"))).toEqual([]);
      expect(scraped.series).toContain("aperture_control_nodes 0");
    }),
  );
});
