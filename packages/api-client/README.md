# @aperture-browser/api-client

Effect services for the [Aperture](https://github.com/tarik02/aperture) API.

```sh
npm install @aperture-browser/api-client effect
```

Each API area is a service: `AuthApi`, `SessionsApi`, `SnapshotsApi`, `TenantsApi`, `UsersApi`, `TokensApi` and `EventsApi`. `apiClientLayer` provides all of them over the `HttpClient` your app supplies. Failures are `ApiRequestError`s carrying the server's error code and HTTP status.

```ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { apiClientLayer, baseUrlLayer, SessionsApi } from "@aperture-browser/api-client";

const credentials = {
  kind: "bearer",
  token: process.env.APERTURE_TOKEN!,
  authorityType: "tenant",
  tenantId: "my-tenant",
  selectedTenantId: null,
} as const;

const program = SessionsApi.use((sessions) => sessions.listSessions(credentials, { limit: 20 }));

const layer = apiClientLayer.pipe(
  Layer.provide(baseUrlLayer("https://aperture.example.com")),
  Layer.provide(FetchHttpClient.layer),
);

const page = await Effect.runPromise(program.pipe(Effect.provide(layer)));
```

Requires `effect` 4.

Documentation: https://aperture-browser-docs.pages.dev/docs/packages/api-client
