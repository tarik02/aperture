import { suite } from "@aperture-browser/e2e/src/suite.ts";
import * as Viewer from "@aperture-browser/e2e/src/viewer.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ENTER, shot } from "./src/console.ts";
import * as Control from "./src/control.ts";

const LOGGED = /^No one can sign in yet: make the first admin at (\S+)$/u;

const needs = Layer.mergeAll(Viewer.layer, Control.layer({ console: true }));

suite(needs)("the first admin at the console", (it) => {
  it.effect("whoever opens the link the control plane logged is made an admin and signed in", () =>
    Effect.gen(function* () {
      const control = yield* Control.Control;
      const viewer = yield* Viewer.Viewer;
      const fs = yield* FileSystem.FileSystem;
      const link = control
        .warned()
        .map((line) => LOGGED.exec(line)?.[1])
        .find((found) => found !== undefined);
      expect(link).toBeDefined();

      const page = yield* viewer.open(link ?? "");
      const form = `[data-console-first-admin="asked"]`;
      yield* page.until(`!!document.querySelector('${form} input[name="name"]')`);
      yield* page.click(`${form} input[name="name"]`);
      yield* page.type("Ada");
      yield* page.click(`${form} input[name="email"]`);
      yield* page.type("ada@example.test");
      yield* page.click(`${form} input[name="password"]`);
      yield* page.type("a password of Ada's own");
      yield* shot(page, fs, "console-first-admin");
      yield* page.key("Enter", "Enter", ENTER);

      // Signed in by the cookies the form left, and on the first page an admin is offered.
      yield* page.until(`location.pathname === "/-/sessions"`, "30 seconds");
      const me = yield* page.evaluate(
        `fetch("/api/control/account").then((answer) => answer.json())`,
        Schema.Struct({ name: Schema.String, email: Schema.String, admin: Schema.Boolean }),
      );
      expect(me).toEqual({ name: "Ada", email: "ada@example.test", admin: true });

      // The link again, as anyone who has it: it asks nothing and makes nobody.
      yield* page.evaluate(`void location.assign(${JSON.stringify(link)})`);
      yield* page.until(`!!document.querySelector('[data-console-first-admin="refused"]')`);
      expect(yield* page.evaluate(`!!document.querySelector('${form}')`, Schema.Boolean)).toBe(
        false,
      );
      expect(page.errors()).toEqual([]);
    }),
  );
});
