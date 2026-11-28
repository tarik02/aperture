import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Actions } from "./service.ts";

export const makeActions = Effect.fn("Actions.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const file = yield* Config.option(Config.String("GITHUB_OUTPUT"));

  const output = Effect.fn("Actions.output")(function* (name: string, value: string) {
    if (Option.isNone(file)) {
      yield* Console.log(`${name}=${value}`);
      return;
    }
    // A delimiter no value has in it, as GitHub asks of a value of several lines.
    const line = value.includes("\n")
      ? yield* crypto.randomUUIDv4.pipe(
          Effect.map((delimiter) => `${name}<<${delimiter}\n${value}\n${delimiter}\n`),
        )
      : `${name}=${value}\n`;
    yield* fs.writeFileString(file.value, line, { flag: "a" });
  });

  return Actions.of({ output });
});

export const layer = Layer.effect(Actions, makeActions());
