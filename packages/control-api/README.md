# @aperture-browser/control-api

The API of an [Aperture](https://github.com/tarik02/aperture) control plane, as an [Effect](https://effect.website) `HttpApi`: every route, what goes over it and how it fails. The control plane serves from this definition, so a client made of it cannot disagree with the server.

```sh
npm install @aperture-browser/control-api@beta effect
```

While Aperture is in beta its packages are under the dist-tag `beta`; a package has the version of the server it speaks to.

```ts
import * as Client from "@aperture-browser/control-api/client";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const program = Effect.gen(function* () {
  const api = yield* Client.make({
    baseUrl: "https://aperture.example.com",
    token: process.env["APERTURE_TOKEN"] ?? "",
  });
  const session = yield* api.sessions.create({ payload: { label: "from the API" } });
  const ticket = yield* api.sessions.createTicket({ params: { id: session.id }, payload: {} });
  console.log(`watch it at ${ticket.url}`);
});

Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)));
```

A call fails with the errors its route names, each a class with a `_tag`: `SessionNotFound`, `Forbidden`, `NodeUnreachable` and the rest, from `@aperture-browser/control-api/errors`.

| Entry | What it has |
|---|---|
| `.` | `Api` and its groups, the schemas of what they exchange (`Session`, `Snapshot`, `Scope`, `Access`, …), and the errors |
| `./client` | `make({ baseUrl, token })`: the API for whoever holds a token |
| `./errors` | The errors alone |

The same routes are described for any other client at `<control plane>/api/control/openapi.json`. What is inside a session, its picture and input, is `@aperture-browser/session-client`.
