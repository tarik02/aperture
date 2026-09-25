# @aperture-browser/api-client

Effect services for the [Aperture](https://github.com/tarik02/aperture) API.

```sh
npm install @aperture-browser/api-client effect
```

Each API area is a service: `AuthApi`, `SessionsApi`, `SnapshotsApi`, `TenantsApi`, `UsersApi`, `TokensApi` and `EventsApi`. `apiClientLayer` provides all of them over the `HttpClient` your app supplies. Their methods take the caller's credentials first. Failures are `ApiRequestError`s carrying the server's error code and HTTP status.

A caller that always acts with the same credentials, such as a server holding one API token, can bind them once: `apertureClientLayer(credentials)` provides `ApertureClient`, which exposes the same methods without the credentials argument.

```ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
    baseSnapshotName: base.name,
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

Every paginated list has a `stream…` method, a `Stream` that fetches pages as it is pulled, and a `listAll…` method that collects every page into an array.

## Passkeys

Browser passkey sign-in and registration live in `@aperture-browser/api-client/passkeys`, so the main entry does not depend on `@simplewebauthn/browser`. Install it when you use that entry:

```sh
npm install @simplewebauthn/browser
```

`loginWithPasskey()` and `registerPasskey(name)` run the whole WebAuthn ceremony against `AuthApi` and fail with `PasskeyCeremonyError` when the browser does not complete it.

Requires `effect` 4.

Documentation: https://aperture-browser-docs.pages.dev/docs/packages/api-client
