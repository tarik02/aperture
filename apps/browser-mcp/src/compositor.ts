import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Surface } from "./pointer.ts";

export interface CompositorConfig {
  socket: string;
  targetsUrl: string;
}
const Targets = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      targetId: Schema.String,
      surfaceId: Schema.Number,
      state: Schema.String,
      viewport: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
    }),
  ),
);

export function sendCommand(
  socketPath: string,
  line: string,
  signal?: AbortSignal,
): Promise<string> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* NodeSocket.makeNet({ path: socketPath });
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        yield* writer.write(`${line}\n`);
        let reply = "";
        const decoder = new TextDecoder();
        while (!reply.includes("\n")) {
          const chunks = yield* reader.pull;
          for (const chunk of chunks) {
            reply += typeof chunk === "string" ? chunk : decoder.decode(chunk);
          }
        }
        const answer = reply.trim();
        if (!answer.startsWith("ok")) {
          return yield* Effect.fail(new Error(`compositor rejected command: ${answer}`));
        }
        return answer;
      }),
    ).pipe(Effect.timeout("5 seconds")),
    { signal },
  );
}

export async function surfaceOf(
  config: CompositorConfig,
  targetId: string,
  signal?: AbortSignal,
): Promise<Surface> {
  // Failure is actionable: falling back to a different input device would hide it.
  const response = await fetch(config.targetsUrl, { signal });
  if (!response.ok) {
    throw new Error(`target registry answered ${response.status}`);
  }
  const targets = Schema.decodeUnknownSync(Targets)(await response.text());
  const target = targets.find((item) => item.targetId === targetId && item.state === "ready");
  if (target === undefined) {
    throw new Error("browser target has no ready compositor surface");
  }
  return { id: target.surfaceId, width: target.viewport.width, height: target.viewport.height };
}
