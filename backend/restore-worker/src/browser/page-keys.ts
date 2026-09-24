// Symbol.for() keys the target preload sets on restored pages for the worker.
// The worker deletes them once every target has been created.
export const windowOpenKey = "aperture.initial-window-open";
export const preloadErrorKey = "aperture.initial-preload-error";
