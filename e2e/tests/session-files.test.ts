import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { follow } from "../src/http.ts";
import * as Runner from "../src/runner.ts";
import { suite } from "../src/suite.ts";
import { ready, Viewer } from "../src/viewer.ts";
import * as ViewerLive from "../src/viewer.ts";
import { EVERY_FEATURE } from "../src/workbench.ts";

const session = Layer.mergeAll(Runner.layer({ features: EVERY_FEATURE }), ViewerLive.layer);

/** A page that says it ran, and reads the session it is served by as whoever opened it. */
const PAGE = `<!doctype html><title>report</title><script>
  document.title = "ran";
  fetch("/targets" + location.search)
    .then((answer) => answer.json())
    .then((targets) => { document.title = "read " + targets.length; });
</script>`;

const PICTURE = `<svg xmlns="http://www.w3.org/2000/svg"><script>document.title = "ran"</script></svg>`;

const put = (runner: Runner.RunnerService, name: string, content: string) =>
  follow(
    `${runner.url}/uploads/${name}?token=${runner.token}`,
    "PUT",
    new TextEncoder().encode(content),
  );

/** What a route of the session answers with, and how it says it is to be taken. */
const served = Effect.fn("served")(function* (runner: Runner.RunnerService, path: string) {
  const client = yield* HttpClient.HttpClient;
  const answered = yield* client.execute(
    HttpClientRequest.get(`${runner.url}${path}`).pipe(HttpClientRequest.bearerToken(runner.token)),
  );
  return { status: answered.status, headers: answered.headers, text: yield* answered.text };
});

const Navigated = Schema.Struct({
  errorText: Schema.optional(Schema.String),
  isDownload: Schema.optional(Schema.Boolean),
});

suite(session)("what a session's files are served as", (it) => {
  it.effect("a page among the files is a file to keep, of no kind a browser runs", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      expect((yield* put(runner, "report.html", PAGE)).status).toBe(200);
      expect((yield* put(runner, "drawing.svg", PICTURE)).status).toBe(200);

      for (const name of ["report.html", "drawing.svg"]) {
        const file = yield* served(runner, `/files/uploads/${name}`);
        expect(file.status).toBe(200);
        expect(file.headers["content-type"]).toBe("application/octet-stream");
        expect(file.headers["content-disposition"]).toBe(
          `attachment; filename="${name}"; filename*=UTF-8''${name}`,
        );
        expect(file.headers["x-content-type-options"]).toBe("nosniff");
        expect(file.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
      }
    }),
  );

  it.effect("a name is told so that it ends where it does", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const name = `a"b;c é.txt`;
      expect((yield* put(runner, encodeURIComponent(name), "said\n")).status).toBe(200);
      const file = yield* served(runner, `/files/uploads/${encodeURIComponent(name)}`);
      expect(file.text).toBe("said\n");
      expect(file.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(file.headers["content-disposition"]).toBe(
        `attachment; filename="a_b_c _.txt"; filename*=UTF-8''a%22b%3Bc%20%C3%A9.txt`,
      );
    }),
  );

  it.effect("whoever opens a page among the files has it kept, not run where the session is", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const viewer = yield* Viewer;
      const page = yield* viewer.open(runner.page());
      yield* ready(page);
      const before = yield* page.evaluate("location.href", Schema.String);

      for (const name of ["report.html", "drawing.svg"]) {
        const navigated = yield* page.cdp.call(
          "Page.navigate",
          { url: `${runner.url}/files/uploads/${name}?token=${runner.token}` },
          Navigated,
        );
        expect(navigated.isDownload ?? navigated.errorText !== undefined).toBe(true);
        expect(yield* page.evaluate("location.href", Schema.String)).toBe(before);
        expect(yield* page.evaluate("document.title", Schema.String)).not.toMatch(/^(ran|read)/u);
      }
      yield* page.close;
    }),
  );

  it.effect("what else a session answers with is of a kind told, and runs nothing", () =>
    Effect.gen(function* () {
      const runner = yield* Runner.Runner;
      const [target] = yield* runner.targets;
      for (const path of ["/targets", `/targets/${target?.tab}/preview.png`, "/downloads"]) {
        const answer = yield* served(runner, path);
        expect(answer.status).toBe(200);
        expect(answer.headers["x-content-type-options"]).toBe("nosniff");
        expect(answer.headers["content-security-policy"]).toContain("sandbox");
      }
      // The page that shows the session is a page, and is not held so.
      const shown = yield* served(runner, "/");
      expect(shown.headers["content-type"]).toContain("text/html");
      expect(shown.headers["content-security-policy"] ?? "").not.toContain("sandbox");
    }),
  );
});
