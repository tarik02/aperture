import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as App from "./app.ts";
import * as Server from "./server.ts";
import * as SettingsLayer from "./settings/layer.ts";
import { Settings } from "./settings/service.ts";

const server = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* Settings;
    return Server.listen({ host: settings.listenHost, port: settings.listenPort });
  }),
);

App.layer.pipe(
  Layer.provide(server),
  Layer.provide(SettingsLayer.layer),
  Layer.launch,
  NodeRuntime.runMain,
);
