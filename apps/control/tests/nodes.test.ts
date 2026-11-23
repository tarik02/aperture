import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import * as Executor from "@aperture-browser/e2e/src/executor.ts";
import { directory } from "@aperture-browser/e2e/src/process.ts";
import { suite } from "@aperture-browser/e2e/src/suite.ts";
import { until } from "@aperture-browser/e2e/src/wait.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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

suite(Control.layer({ nodeSilentAfter: `${SILENT_AFTER_SECONDS} seconds` }))(
  "nodes that register",
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

    it.effect(
      "a registration token that is revoked registers no node, and the nodes it registered stay",
      () =>
        Effect.gen(function* () {
          const control = yield* Control.Control;
          const bootstrap = yield* control.as(control.bootstrapToken);
          const made = yield* bootstrap.nodes.createRegistrationToken({
            payload: { name: "leaked" },
          });
          expect(made.revokedAt).toBeNull();
          const said = {
            registrationToken: made.token,
            name: "node-kept",
            internalUrl: NOWHERE,
            publicUrl: "https://kept.example",
            operatorToken: "secret",
          };
          expect((yield* control.keepalive(said)).status).toBe(200);

          // Only an admin takes one back, and only one there is.
          const at = { params: { id: made.id } };
          const ada = yield* Control.account("Ada");
          expect((yield* Effect.flip(ada.api.nodes.revokeRegistrationToken(at)))._tag).toBe(
            "Forbidden",
          );
          const none = yield* Effect.flip(
            bootstrap.nodes.revokeRegistrationToken({
              params: { id: "00000000-0000-7000-8000-00000000dead" },
            }),
          );
          expect(none._tag).toBe("RegistrationTokenNotFound");
          yield* bootstrap.nodes.revokeRegistrationToken(at);
          // Taking it back again changes nothing, and is noted once.
          const listed = () =>
            bootstrap.nodes
              .registrationTokens()
              .pipe(Effect.map((all) => all.find((token) => token.id === made.id)));
          const revoked = yield* listed();
          expect(revoked?.revokedAt).not.toBeNull();
          yield* bootstrap.nodes.revokeRegistrationToken(at);
          expect(yield* listed()).toEqual(revoked);
          const noted = yield* bootstrap.events.list({
            query: { kind: "registration_token.revoked", resourceId: made.id },
          });
          expect(noted.events.map((event) => event.resource)).toEqual([
            { kind: "registration_token", id: made.id, label: "leaked" },
          ]);
          expect(JSON.stringify(noted.events)).not.toContain(made.token);

          // No new node registers with it.
          const fresh = yield* control.keepalive({ ...said, name: "node-new" });
          expect(fresh.status).toBe(401);
          expect(fresh.body).toMatchObject({ code: "unauthenticated" });
          expect(yield* node("node-new")).toBeUndefined();

          // The node that registered with it stays, and is heard from as before.
          const before = yield* node("node-kept");
          expect((yield* control.keepalive(said)).status).toBe(200);
          const after = yield* node("node-kept");
          expect(after).toMatchObject({ id: before?.id, alive: true });
          // It says nothing new of itself with it: whoever has the token moves no node.
          for (const changed of [
            { internalUrl: "http://127.0.0.1:10" },
            { publicUrl: "https://elsewhere.example" },
            { balancerUrl: "https://elsewhere.example" },
            { operatorToken: "another" },
          ]) {
            expect((yield* control.keepalive({ ...said, ...changed })).status).toBe(401);
          }
          expect(yield* node("node-kept")).toMatchObject({
            internalUrl: NOWHERE,
            balancerUrl: null,
            publicUrl: "https://kept.example",
          });
          // Nor does it take a node that registered with another token.
          yield* control.keepalive({
            registrationToken: yield* registrationToken,
            name: "node-of-another-token",
            internalUrl: NOWHERE,
            operatorToken: "secret",
          });
          const taken = yield* control.keepalive({ ...said, name: "node-of-another-token" });
          expect(taken.status).toBe(401);
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
        const kept = fromBinary(KeepaliveResponseSchema, new Uint8Array(yield* answer.arrayBuffer));
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

    it.effect("a node's operator token is kept sealed", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const { sql } = control;
        yield* control.keepalive({
          registrationToken: yield* registrationToken,
          name: "node-sealed",
          internalUrl: NOWHERE,
          operatorToken: "an-operator-token-nobody-else-reads",
        });
        const kept = yield* sql`SELECT * FROM nodes WHERE name = 'node-sealed'`;
        expect(kept).toHaveLength(1);
        expect(JSON.stringify(kept)).not.toContain("an-operator-token-nobody-else-reads");
      }),
    );

    it.effect("an executor told of the control plane registers itself, and is reached", () =>
      Effect.gen(function* () {
        const control = yield* Control.Control;
        const fs = yield* FileSystem.FileSystem;
        const file = `${yield* directory}/registration-token`;
        yield* fs.writeFileString(file, `${yield* registrationToken}\n`);
        const executor = yield* Executor.start({
          env: {
            APERTURE_CONTROL_PLANE: control.url,
            APERTURE_REGISTRATION_TOKEN_FILE: file,
            APERTURE_NODE: "node-e",
            APERTURE_PUBLIC_URL: "https://sessions.example/",
          },
        });

        // What it offers is what the control plane read from it with the token it gave.
        const registered = yield* until(
          "the node registering and being reached",
          node("node-e").pipe(Effect.map((listed) => listed?.offers != null && listed)),
        );
        expect(registered).toMatchObject({
          internalUrl: executor.url,
          publicUrl: "https://sessions.example",
          alive: true,
        });
      }).pipe(Effect.scoped),
    );
  },
);
