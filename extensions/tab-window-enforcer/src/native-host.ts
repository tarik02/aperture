import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const nativeHost = "me.tarik02.aperture.tab_window_enforcer";

/** Requests the session wrapper handles, relayed by the Aperture native messaging host. */
export type NativeRequest =
  | { readonly type: "binding.prepare"; readonly nonce: string }
  | { readonly type: "binding.cancel"; readonly nonce: string }
  | {
      readonly type: "binding.bind";
      readonly nonce: string;
      readonly windowId: number;
      readonly tabId: number;
    }
  | { readonly type: "window.settled"; readonly windowId: number; readonly tabId: number }
  | { readonly type: "window.closed"; readonly windowId: number };

const NativeResponse = Schema.Struct({
  id: Schema.String,
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});
type NativeResponse = typeof NativeResponse.Type;
const decodeResponse = Schema.decodeUnknownOption(NativeResponse);

export class NativeHostError extends Schema.TaggedError<NativeHostError>()("NativeHostError", {
  message: Schema.String,
}) {}

const rejections: Record<NativeRequest["type"], string> = {
  "binding.prepare": "Aperture rejected the window binding preparation",
  "binding.cancel": "Aperture rejected the window binding cancellation",
  "binding.bind": "Aperture rejected the window binding",
  "window.settled": "Aperture rejected the settled window",
  "window.closed": "Aperture rejected the window close report",
};

export class NativeHost extends Context.Service<
  NativeHost,
  {
    /** Sends a request and fails unless Aperture accepts it. */
    readonly request: (message: NativeRequest) => Effect.Effect<void, NativeHostError>;
  }
>()("@aperture/tab-window-enforcer/NativeHost") {
  static readonly layer = Layer.sync(NativeHost, () => {
    // One port, opened on first use and again after the host disconnects.
    let port: chrome.runtime.Port | null = null;
    let nextRequestId = 0;
    const pending = new Map<string, Deferred.Deferred<NativeResponse, NativeHostError>>();

    const connect = (): chrome.runtime.Port => {
      if (port !== null) return port;
      const connected = chrome.runtime.connectNative(nativeHost);
      connected.onMessage.addListener((message: unknown) => {
        const response = decodeResponse(message);
        if (Option.isNone(response)) return;
        const deferred = pending.get(response.value.id);
        if (deferred) Deferred.doneUnsafe(deferred, Effect.succeed(response.value));
      });
      connected.onDisconnect.addListener(() => {
        const error = new NativeHostError({
          message: chrome.runtime.lastError?.message ?? "Aperture native host disconnected",
        });
        for (const deferred of pending.values()) Deferred.doneUnsafe(deferred, Effect.fail(error));
        pending.clear();
        port = null;
      });
      port = connected;
      return connected;
    };

    const request = Effect.fn("NativeHost.request")(function* (message: NativeRequest) {
      nextRequestId += 1;
      const id = String(nextRequestId);
      const deferred = Deferred.makeUnsafe<NativeResponse, NativeHostError>();
      pending.set(id, deferred);
      const response = yield* Effect.try({
        try: () => connect().postMessage({ ...message, id }),
        catch: (cause) => new NativeHostError({ message: String(cause) }),
      }).pipe(
        Effect.andThen(Deferred.await(deferred)),
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      );
      if (!response.ok) {
        return yield* new NativeHostError({ message: response.error ?? rejections[message.type] });
      }
    });

    return NativeHost.of({ request });
  });
}
