import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import manifest from "../package.json" with { type: "json" };
import * as App from "./app.ts";
import { NotMappable } from "./errors.ts";
import { Migrator } from "./migrator/service.ts";
import { render } from "./report.ts";

const flags = {
  v1Database: Flag.String("v1-database").pipe(
    Flag.withDescription("v1's database_path: the SQLite file of a v1 that is stopped"),
  ),
  v1ColdRoot: Flag.String("v1-cold-root").pipe(
    Flag.withDescription(
      "v1's cold_root, where its snapshots and its sessions' files are; the database's directory without",
    ),
    Flag.optional,
  ),
  v1StoreRoot: Flag.String("v1-store-root").pipe(
    Flag.withDescription(
      "v1's store_root, where its sessions' profiles are; its cold root without",
    ),
    Flag.optional,
  ),
  node: Flag.String("node").pipe(
    Flag.withDescription(
      "The node that takes v1's snapshots and sessions, by the name it registered with",
    ),
    Flag.optional,
  ),
  nodeStore: Flag.String("node-store").pipe(
    Flag.withDescription("That node's APERTURE_DATA_DIR, on this machine"),
    Flag.optional,
  ),
  tokens: Flag.Literals("tokens", ["keep", "reissue", "drop"]).pipe(
    Flag.withDescription(
      "What becomes of v1's API tokens: each works as it did, a new one is in its place, or none is",
    ),
    Flag.withDefault("keep"),
  ),
  secretsFile: Flag.String("secrets-file").pipe(
    Flag.withDescription(
      "Where the secrets of the tokens made anew are written, a line of JSON each",
    ),
    Flag.optional,
  ),
  sessions: Flag.Literals("sessions", ["drop"]).pipe(
    Flag.withDescription("Leave v1's sessions behind, with their files and recordings"),
    Flag.optional,
  ),
};

type Flags = Command.Command.Config.Infer<typeof flags>;

const asked = (given: Flags): App.Asked => ({
  ...given,
  sessions: Option.getOrUndefined(given.sessions),
});

const plan = Command.make("plan", flags, (given) =>
  Effect.gen(function* () {
    const migrator = yield* Migrator;
    const planned = yield* migrator.plan();
    yield* Console.log(render(planned));
    if (planned.conflicts.length > 0) {
      return yield* new NotMappable({ conflicts: planned.conflicts.length });
    }
  }).pipe(Effect.provide(App.layer(asked(given)))),
).pipe(Command.withDescription("Tell what moving v1 into v2 would come to, and move nothing"));

const apply = Command.make("apply", flags, (given) =>
  Effect.gen(function* () {
    const migrator = yield* Migrator;
    const planned = yield* migrator.plan();
    yield* Console.log(render(planned));
    const done = yield* migrator.apply();
    yield* Console.log(done.steps.length === 0 ? "nothing to move" : `moved: ${done.steps.length}`);
  }).pipe(Effect.provide(App.layer(asked(given)))),
).pipe(Command.withDescription("Move what the plan says; again, it goes on or does nothing"));

const migrate = Command.make("aperture-migrate").pipe(
  Command.withDescription("Moves what an Aperture v1 installation kept into v2"),
  Command.withSubcommands([plan, apply]),
);

NodeRuntime.runMain(
  Command.run(migrate, { version: manifest.version }).pipe(
    Effect.tapError((error) =>
      CliError.isCliError(error) ? Effect.void : Console.error(String(error)),
    ),
    Effect.provide(NodeServices.layer),
  ),
  { disableErrorReporting: true },
);
