import * as Effect from "effect/Effect";

export interface Answer {
  readonly status: number;
  /** The body as JSON where it is JSON, and as text otherwise. */
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly body: any;
}

/** A request with a token, whose answer is told whatever its status. */
export const request = (
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<Answer> =>
  Effect.promise(async () => {
    const answered = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await answered.text();
    try {
      return { status: answered.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: answered.status, body: text };
    }
  });
