import {
  create,
  type DescMessage,
  fromBinary,
  fromJsonString,
  type MessageInitShape,
  type MessageShape,
  toBinary,
  toJsonString,
} from "@bufbuild/protobuf";
import { durationFromMs } from "@bufbuild/protobuf/wkt";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { NodeService } from "../gen/aperture/control/v1/nodes_pb.ts";
import { Nodes } from "../nodes.ts";

const STATUS = {
  invalid_argument: 400,
  unauthenticated: 401,
  internal: 500,
} as const;

/** A call that is not answered, as Connect tells one: its code and why. */
class Refused extends Schema.TaggedError<Refused>()("Refused", {
  code: Schema.Literals(["invalid_argument", "unauthenticated", "internal"]),
  message: Schema.String,
}) {}

const UNSUPPORTED_MEDIA_TYPE = 415;

/**
 * One call of a service as Connect has a unary one: a POST whose body is the request as
 * JSON or as protobuf, answered in kind, and a refusal as JSON with its code.
 */
const unary = <I extends DescMessage, O extends DescMessage>(
  method: { readonly input: I; readonly output: O },
  answer: (asked: MessageShape<I>) => Effect.Effect<MessageInitShape<O>, Refused>,
) =>
  Effect.fn(function* (request: HttpServerRequest.HttpServerRequest) {
    const type = request.headers["content-type"] ?? "";
    const json = type.startsWith("application/json");
    if (!json && !type.startsWith("application/proto")) {
      return HttpServerResponse.empty({ status: UNSUPPORTED_MEDIA_TYPE });
    }
    const unreadable = (cause: unknown) =>
      new Refused({
        code: "invalid_argument",
        message: `the request is not read: ${String(cause)}`,
      });
    const asked = json
      ? request.text.pipe(
          Effect.mapError(unreadable),
          Effect.flatMap((text) =>
            Effect.try({
              try: () => fromJsonString(method.input, text, { ignoreUnknownFields: true }),
              catch: unreadable,
            }),
          ),
        )
      : request.arrayBuffer.pipe(
          Effect.mapError(unreadable),
          Effect.flatMap((body) =>
            Effect.try({
              try: () => fromBinary(method.input, new Uint8Array(body)),
              catch: unreadable,
            }),
          ),
        );
    return yield* asked.pipe(
      Effect.flatMap(answer),
      Effect.map((answered) => {
        const message = create(method.output, answered);
        return json
          ? HttpServerResponse.text(toJsonString(method.output, message), {
              contentType: "application/json",
            })
          : HttpServerResponse.uint8Array(toBinary(method.output, message), {
              contentType: "application/proto",
            });
      }),
      Effect.catch((refused) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { code: refused.code, message: refused.message },
            { status: STATUS[refused.code] },
          ),
        ),
      ),
    );
  });

const path = (method: { readonly name: string }) =>
  `/${NodeService.typeName}/${method.name}` as const;

/** `aperture.control.v1.NodeService`, which nodes call and no account does. */
export const layer = HttpRouter.use(
  Effect.fn(function* (router) {
    const nodes = yield* Nodes;
    yield* router.add(
      "POST",
      path(NodeService.method.keepalive),
      unary(NodeService.method.keepalive, (said) =>
        nodes.keepalive(said).pipe(
          Effect.map(({ node, againAfter }) => ({
            nodeId: node.id,
            againAfter: durationFromMs(Duration.toMillis(againAfter)),
          })),
          Effect.catchTags({
            RegistrationRefused: (error) =>
              Effect.fail(new Refused({ code: "unauthenticated", message: error.message })),
            KeepaliveInvalid: (error) =>
              Effect.fail(new Refused({ code: "invalid_argument", message: error.message })),
          }),
        ),
      ),
    );
  }),
);
