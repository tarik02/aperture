import { fileURLToPath } from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { TargetPreload } from "./browser/target.js";

// Each bundle declares its global name with `var`; the function scope keeps it out of the page.
function source(bundle: string, entrypoint: string, state: unknown): string {
  return `(() => {\n${bundle}\nreturn ${entrypoint}.run(${JSON.stringify(state)});\n})()`;
}

/** Builds the scripts evaluated inside browser pages from the bundles next to the worker. */
export class PayloadSource extends Context.Service<
  PayloadSource,
  {
    readonly target: (state: TargetPreload) => string;
    readonly sessionStorage: (state: unknown) => string;
    readonly originStorage: (state: unknown) => string;
    /** Evaluates to the src/browser/document.ts module, for use through a JSHandle. */
    readonly documentHelpers: () => string;
  }
>()("@aperture/restore-worker/PayloadSource") {
  static readonly layer = Layer.effect(
    PayloadSource,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const read = (name: string) =>
        fs.readFileString(fileURLToPath(new URL(`./${name}`, import.meta.url)));
      const [target, sessionStorage, originStorage, document] = yield* Effect.all([
        read("target.js"),
        read("session-storage.js"),
        read("origin-storage.js"),
        read("document.js"),
      ]);

      return PayloadSource.of({
        target: (state) => source(target, "ApertureTargetRestore", state),
        sessionStorage: (state) => source(sessionStorage, "ApertureSessionStorageRestore", state),
        originStorage: (state) => source(originStorage, "ApertureOriginStorageRestore", state),
        documentHelpers: () => `(() => {\n${document}\nreturn ApertureDocument;\n})()`,
      });
    }),
  );
}
