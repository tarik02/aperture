declare module "virtual:runner-state" {
  /** What `crates/runner/src/live/state/stored.js` evaluates to. */
  export const stored: import("./page-keys.ts").Stored;
  /** What `crates/runner/src/live/state/document.js` evaluates to. */
  export const documentOf: (
    stored: import("./page-keys.ts").Stored,
  ) => import("./page-keys.ts").DocumentState;
}
