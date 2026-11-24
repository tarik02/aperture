import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { V1DatabaseUnusable, V1SchemaUnexpected } from "../errors.ts";
import type { V1Data } from "./schemas.ts";

/**
 * A v1 installation that is not running: its database and what it keeps on disk. It is
 * read and never written.
 */
export interface V1SourceShape {
  readonly read: () => Effect.Effect<V1Data, V1DatabaseUnusable | V1SchemaUnexpected>;
}

export class V1Source extends Context.Service<V1Source, V1SourceShape>()(
  "@aperture-browser/migrate/V1Source",
) {}
