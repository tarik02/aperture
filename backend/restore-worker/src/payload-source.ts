import { readFileSync } from "node:fs";

const sources = {
  target: readFileSync(new URL("./target.js", import.meta.url), "utf8"),
  sessionStorage: readFileSync(new URL("./session-storage.js", import.meta.url), "utf8"),
  originStorage: readFileSync(new URL("./origin-storage.js", import.meta.url), "utf8"),
};

// Each bundle declares its global name with `var`; the function scope keeps it out of the page.
function source(bundle: string, entrypoint: string, state: unknown): string {
  return `(() => {\n${bundle}\nreturn ${entrypoint}.run(${JSON.stringify(state)});\n})()`;
}

export function targetStateSource(state: unknown): string {
  return source(sources.target, "ApertureTargetRestore", state);
}

export function sessionStorageSource(state: unknown): string {
  return source(sources.sessionStorage, "ApertureSessionStorageRestore", state);
}

export function originStorageSource(state: unknown): string {
  return source(sources.originStorage, "ApertureOriginStorageRestore", state);
}
