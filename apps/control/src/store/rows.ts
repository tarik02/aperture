import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";

type Statement = Effect.Effect<ReadonlyArray<unknown>, SqlError>;

/**
 * The rows a statement gives, as the schema reads them. A database that fails, or gives
 * what the schema does not know, is nothing a caller can do anything about: it is a defect.
 */
export const all =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (statement: Statement) =>
    statement.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(schema))), Effect.orDie);

/** The first row a statement gives, where there is one. */
export const first =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (statement: Statement) =>
    all(schema)(statement).pipe(Effect.map(Arr.head));

/** A statement run for what it does. */
export const done = (statement: Statement) => statement.pipe(Effect.asVoid, Effect.orDie);

/** The row a statement is sure to give, as one that returns what it wrote. */
export const one =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (statement: Statement) =>
    first(schema)(statement).pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);
