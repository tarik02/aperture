import {
  create,
  type DescMessage,
  fromJson,
  type JsonValue,
  type MessageInitShape,
  type MessageShape,
  toJson,
} from "@bufbuild/protobuf";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ExecutorError, ExecutorErrorCode } from "./errors.ts";

/** Where an executor is and what lets a caller in. */
export interface Address {
  /** The executor's base, such as `https://node.example`. */
  readonly url: string;
  /** The operator token. */
  readonly token: string;
}

export interface Method<Input extends DescMessage, Output extends DescMessage> {
  readonly name: string;
  readonly input: Input;
  readonly output: Output;
}

const SERVICE = "aperture.executor.v1.ExecutorService";

// What answers before the service does, the check of the token among it, says why in plain
// text, so its status stands in for a code as Connect maps one.
const codeOfStatus = (status: number): ExecutorErrorCode => {
  switch (status) {
    case 400:
      return "internal";
    case 401:
      return "unauthenticated";
    case 403:
      return "permission_denied";
    case 404:
      return "unimplemented";
    case 429:
    case 502:
    case 503:
    case 504:
      return "unavailable";
    default:
      return "unknown";
  }
};

const isCode = Schema.is(ExecutorErrorCode);

const refused = (status: number, text: string): ExecutorError => {
  let told: unknown;
  try {
    told = JSON.parse(text);
  } catch {
    told = undefined;
  }
  if (typeof told === "object" && told !== null && "code" in told && isCode(told.code)) {
    const message = "message" in told && typeof told.message === "string" ? told.message : "";
    return new ExecutorError({
      code: told.code,
      message: message === "" ? told.code : message,
      status,
    });
  }
  const message = text.trim() === "" ? `the executor answered ${status}` : text.trim();
  return new ExecutorError({ code: codeOfStatus(status), message, status });
};

const failed = (cause: unknown): ExecutorError =>
  new ExecutorError({
    code: "unavailable",
    message: cause instanceof Error ? cause.message : "the executor could not be reached",
    cause,
  });

const misread = (cause: unknown): ExecutorError =>
  new ExecutorError({
    code: "internal",
    message: cause instanceof Error ? cause.message : "the executor's answer was not read",
    cause,
  });

export const call = Effect.fnUntraced(function* <
  Input extends DescMessage,
  Output extends DescMessage,
>(address: Address, method: Method<Input, Output>, request: MessageInitShape<Input>) {
  const base = address.url.replace(/\/+$/u, "");
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(`${base}/${SERVICE}/${method.name}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${address.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toJson(method.input, create(method.input, request))),
        signal,
      }),
    catch: failed,
  });
  const text = yield* Effect.tryPromise({ try: () => response.text(), catch: failed });
  if (!response.ok) {
    return yield* refused(response.status, text);
  }
  return yield* Effect.try({
    // A later executor may tell more than this client knows of.
    try: (): MessageShape<Output> =>
      fromJson(method.output, JSON.parse(text) as JsonValue, { ignoreUnknownFields: true }),
    catch: misread,
  });
});
