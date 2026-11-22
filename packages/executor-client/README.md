# @aperture-browser/executor-client

An [Effect](https://effect.website) client for one [Aperture](https://github.com/tarik02/aperture) executor: the sessions of one node and the snapshots taken of them. It is for whoever runs nodes without a control plane, or writes one; it takes the executor's operator token.

```sh
npm install @aperture-browser/executor-client effect
```

```ts
import { make } from "@aperture-browser/executor-client";
import * as Effect from "effect/Effect";

const executor = make({ url: "http://node.internal:7900", token: process.env["APERTURE_TOKEN"] ?? "" });

const program = Effect.gen(function* () {
  const session = yield* executor.sessions.create({ suspended: true });
  console.log(session.id, (yield* executor.sessions.list).length);
  yield* executor.sessions.delete(session.id);
});

Effect.runPromise(program);
```

A call fails with an `ExecutorError`, whose `code` is the executor's own: `not_found`, `failed_precondition` and the rest. `layer(address)` gives the same client as the `Executor` service; `proto` has the messages.
