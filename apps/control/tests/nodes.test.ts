import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import {
  KeepaliveRequestSchema,
  KeepaliveResponseSchema,
} from "../src/gen/aperture/control/v1/nodes_pb.ts";
import * as Control from "./src/control.ts";

const SILENT_AFTER_SECONDS = 2;

/** Nothing listens there: a node that says it is there, and is not. */
const NOWHERE = "http://127.0.0.1:9";

const Kept = Schema.Struct({ nodeId: Schema.String, againAfter: Schema.String });

const registrationToken = Effect.gen(function* () {
  const control = yield* Control.Control;
  const bootstrap = yield* control.as(control.bootstrapToken);
  const made = yield* bootstrap.nodes.createRegistrationToken({ payload: { name: "checks" } });
  return made.token;
});

const node = (name: string) =>
  Effect.gen(function* () {
    const control = yield* Control.Control;
    const bootstrap = yield* control.as(control.bootstrapToken);
    const nodes = yield* bootstrap.nodes.list();
    return nodes.find((listed) => listed.name === name);
  });

for (const stores of Control.STORES) {
  suite(Control.layer({ stores, nodeSilentAfter: `${SILENT_AFTER_SECONDS} seconds` }))(
    `nodes that register, kept in ${stores}`,
    (it) => {
      it.effect("a keepalive with no registration token that was made is refused", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const answer = yield* control.keepalive({
            registrationToken: "apr_not-a-token",
            name: "intruder",
            internalUrl: NOWHERE,
            operatorToken: "secret",
          });
          expect(answer.status).toBe(401);
          expect(answer.body).toMatchObject({ code: "unauthenticated" });
          expect(yield* node("intruder")).toBeUndefined();
        }),
      );

      it.effect("only an admin makes registration tokens and sees the nodes", () =>
        Effect.gen(function* () {
          const ada = yield* Control.account("Ada");
          const refused = yield* Effect.flip(
            ada.api.nodes.createRegistrationToken({ payload: { name: "mine" } }),
          );
          expect(refused._tag).toBe("Forbidden");
          expect((yield* Effect.flip(ada.api.nodes.list()))._tag).toBe("Forbidden");
        }),
      );

      it.effect("a node registers with a registration token and is alive", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const token = yield* registrationToken;
          expect(token).toMatch(/^apr_/u);

          const answer = yield* control.keepalive({
            registrationToken: token,
            name: "node-a",
            internalUrl: `${NOWHERE}/`,
            publicUrl: "https://a.example",
            operatorToken: "secret",
          });
          expect(answer.status).toBe(200);
          const kept = yield* Schema.decodeUnknownEffect(Kept)(answer.body);
          // A third of what a node may be silent for, so that a lost one does no harm.
          expect(Number.parseFloat(kept.againAfter)).toBeCloseTo(SILENT_AFTER_SECONDS / 3, 2);

          const listed = yield* node("node-a");
          expect(listed).toMatchObject({
            id: kept.nodeId,
            internalUrl: NOWHERE,
            balancerUrl: null,
            publicUrl: "https://a.example",
            alive: true,
          });
          expect(listed).not.toHaveProperty("operatorToken");

          const again = yield* control.keepalive({
            registrationToken: token,
            name: "node-a",
            internalUrl: NOWHERE,
            operatorToken: "secret",
          });
          expect((yield* Schema.decodeUnknownEffect(Kept)(again.body)).nodeId).toBe(kept.nodeId);
        }),
      );

      it.effect("a keepalive is taken as protobuf too, and answered in kind", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const client = yield* HttpClient.HttpClient;
          const said = create(KeepaliveRequestSchema, {
            registrationToken: yield* registrationToken,
            name: "node-b",
            internalUrl: NOWHERE,
            operatorToken: "secret",
          });
          const answer = yield* client.execute(
            HttpClientRequest.post(`${control.url}${Control.KEEPALIVE}`).pipe(
              HttpClientRequest.bodyUint8Array(
                toBinary(KeepaliveRequestSchema, said),
                "application/proto",
              ),
            ),
          );
          expect(answer.status).toBe(200);
          const kept = fromBinary(
            KeepaliveResponseSchema,
            new Uint8Array(yield* answer.arrayBuffer),
          );
          expect((yield* node("node-b"))?.id).toBe(kept.nodeId);
        }),
      );

      it.effect("a keepalive that does not say where the node is is refused", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const answer = yield* control.keepalive({
            registrationToken: yield* registrationToken,
            name: "node-c",
            internalUrl: "not an address",
            operatorToken: "secret",
          });
          expect(answer.status).toBe(400);
          expect(answer.body).toMatchObject({ code: "invalid_argument" });
        }),
      );

      it.effect("a node that has been silent too long is not alive, and gets no session", () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          yield* control.keepalive({
            registrationToken: yield* registrationToken,
            name: "node-d",
            internalUrl: NOWHERE,
            operatorToken: "secret",
          });
          expect((yield* node("node-d"))?.alive).toBe(true);

          yield* until(
            "the node counting as silent",
            node("node-d").pipe(Effect.map((listed) => listed?.alive === false)),
          );
          // It is still known: a node that comes back is the node it was.
          expect(yield* node("node-d")).toBeDefined();

          const ada = yield* Control.account("Ada");
          const refused = yield* Effect.flip(ada.api.sessions.create({ payload: {} }));
          expect(refused._tag).toBe("NoNode");
        }),
      );
    },
  );
}
