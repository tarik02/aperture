# @aperture-browser/api-client

Effect services for the [Aperture](https://github.com/tarik02/aperture) API.

```sh
npm install @aperture-browser/api-client effect
```

Each API area is a service: `AuthApi`, `SessionsApi`, `SnapshotsApi`, `TenantsApi`, `UsersApi`, `TokensApi`, `EventsApi` and `HealthApi`. `apiClientLayer` provides all of them over the `HttpClient` your app supplies. Their methods take the caller's credentials first. Failures are `ApiRequestError`s carrying the server's error code and HTTP status.

A caller that always acts with the same credentials, such as a server holding one API token, can bind them once: `apertureClientLayer(credentials)` provides `ApertureClient`, which exposes the same methods without the credentials argument, plus `auth.getAuthMe()` and `health.getHealth()`.

```ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ApertureClient, apertureClientLayer, baseUrlLayer } from "@aperture-browser/api-client";

const layer = apertureClientLayer({
  kind: "bearer",
  token: process.env.APERTURE_TOKEN!,
  authorityType: "tenant",
  tenantId: null,
  selectedTenantId: null,
}).pipe(
  Layer.provide(baseUrlLayer("https://aperture.example.com")),
  Layer.provide(FetchHttpClient.layer),
);

const program = Effect.gen(function* () {
  const client = yield* ApertureClient;
  const base = yield* client.snapshots.getSnapshotByName("signed-in-base");
  const { session } = yield* client.sessions.createSession({
    baseSnapshotName: Option.isSome(base) ? base.value.name : null,
    browser: { channel: "chromium" },
    proxy: {
      upstreams: { office: { url: "socks5://user:pass@proxy.example.com:1080" } },
      rules: [{ match: "*", via: "office" }],
    },
  });
  yield* client.sessions.updateSessionProxy(session.id, { rules: [], drain: true });
  return yield* client.sessions.streamSessions({ status: "running" }).pipe(Stream.runCount);
});

await Effect.runPromise(program.pipe(Effect.provide(layer)));
```

`withCredentials(service, credentials)` binds credentials to a single service the same way.

## Pagination

Every paginated list (sessions, snapshots, tenants, users, admin and tenant tokens, events, audit events) has the same three calls, derived from one generic so they stay aligned:

- `listX(params)` fetches one page; pass the previous page's `meta.nextCursor` as `cursor`.
- `streamX(filter)` is a `Stream` of items across pages, fetching the next page only when pulled.
- `listAllX(filter)` collects every page into an array.

The filter is `listX`'s params without `cursor`; its `limit` is the page size.

```ts
const page = yield* client.sessions.listSessions({ status: "running", limit: 20 });
const next = yield* client.sessions.listSessions({ status: "running", limit: 20, cursor: page.meta.nextCursor });
const all = yield* client.sessions.listAllSessions({ status: "running", limit: 100 });
```

## Session files and the live session

`listSessionFiles(sessionId)` lists a session's files (downloads, recordings, uploads and Playwright output), also while it is not running. The live-session calls reach the running session directly and take an optional `sessionToken` in place of the credentials: `uploadSessionFiles` stores files in its `uploads` directory for browser file inputs, `setSessionViewport` resizes a target, and `streamSessionRecording` streams a recording without buffering it (`downloadSessionRecording` returns a `Blob`).

Upload contents may be a `Blob`, a `Uint8Array` or a `Stream` of bytes. Blobs and byte arrays are sent as `FormData`; any stream makes the whole body a streamed request, which browsers other than Chromium cannot send. A failure inside the running session is an `ApiRequestError` with code `live_session_error`, its HTTP status, and the session's message.

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";

const program = Effect.gen(function* () {
  const client = yield* ApertureClient;
  const fs = yield* FileSystem.FileSystem;
  const uploaded = yield* client.sessions.uploadSessionFiles(sessionId, [
    { name: "invoice.pdf", content: fs.stream("./invoice.pdf") },
  ]);
  // uploaded[0].relativePath is "uploads/invoice.pdf", ready for browser_file_upload.
  yield* client.sessions.setSessionViewport(sessionId, { targetId, width: 1280, height: 720 });
  yield* client.sessions
    .streamSessionRecording(sessionId, recordingId)
    .pipe(Stream.run(fs.sink("./recording.webm")));
}).pipe(Effect.provide(NodeFileSystem.layer));
```

## Passkeys

Browser passkey sign-in and registration live in `@aperture-browser/api-client/passkeys`, so the main entry does not depend on `@simplewebauthn/browser`. Install it when you use that entry:

```sh
npm install @simplewebauthn/browser
```

`loginWithPasskey()` and `registerPasskey(name)` run the whole WebAuthn ceremony against `AuthApi`. They fail with `PasskeyCeremonyError` when the browser does not complete it; its `reason` is `cancelled` when the user dismissed the prompt or it timed out, and `failed` otherwise.

Requires `effect` 4.

Documentation: https://aperture-browser-docs.pages.dev/docs/packages/api-client
