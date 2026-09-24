import { posix } from "node:path";
import { z } from "zod";

const nonNegative = z.number().int().nonnegative();
const entry = z.strictObject({ name: z.string(), value: z.string() });

const entries = z.array(entry).superRefine((values, ctx) =>
  unique(
    values.map((value) => value.name),
    ctx,
  ),
);

const htmlTag = z.string().regex(/^[a-z][a-z0-9-]*$/);

const locator = z.strictObject({
  tag: htmlTag,
  id: z.string().optional(),
  name: z.string().optional(),
  inputType: z.string().optional(),
  autocomplete: z.string().optional(),
  ariaLabel: z.string().optional(),
  placeholder: z.string().optional(),
  path: z.array(z.strictObject({ tag: htmlTag, index: nonNegative })).max(256),
});

const endpoint = z.strictObject({
  locator,
  nodePath: z.array(nonNegative).max(256),
  offset: nonNegative,
});

const documentState = z
  .strictObject({
    version: z.literal(1),
    windowName: z.string().optional(),
    historyState: z.string().optional(),
    controls: z
      .array(
        z.strictObject({
          locator,
          value: z.string(),
          checked: z.boolean().optional(),
          selectedIndices: z.array(nonNegative).optional(),
          selection: z
            .strictObject({
              start: nonNegative,
              end: nonNegative,
              direction: z.enum(["forward", "backward", "none"]),
            })
            .optional(),
        }),
      )
      .max(10000),
    contentEditables: z.array(z.strictObject({ locator, html: z.string() })).max(10000),
    scrollPositions: z
      .array(z.strictObject({ locator, x: z.number().finite(), y: z.number().finite() }))
      .max(10000),
    focus: locator.optional(),
    selection: z.strictObject({ anchor: endpoint, focus: endpoint }).optional(),
  })
  .superRefine((value, ctx) => {
    if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024)
      issue(ctx, "documentState exceeds 32 MiB");

    if (value.historyState != null && !validJSON(value.historyState))
      issue(ctx, "historyState must contain valid structured-clone JSON");

    value.controls.forEach((control, index) => {
      if (control.selection && control.selection.end < control.selection.start) {
        ctx.addIssue({
          code: "custom",
          message: "selection range is reversed",
          path: ["controls", index, "selection"],
        });
      }
    });
  });

const origin = z
  .string()
  .refine(
    (value) => canonicalOrigin(value) !== null,
    "origin must contain only an http or https scheme and host",
  );

const httpURL = z.string().refine((value) => {
  try {
    const parsed = new URL(value.trim());
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}, "must be an absolute http or https URL without embedded credentials");

const encodedJSON = z.string().refine(validJSON, "must contain valid structured-clone JSON");

const base64Text = z.base64();
const base64 = z
  .string()
  .refine(
    (value) => base64Text.safeParse(value.replaceAll(/\r|\n/g, "")).success,
    "must be valid base64",
  );

const stringKeyPath = z.strictObject({
  kind: z.literal("string"),
  value: z.tuple([z.string()]),
});

const arrayKeyPath = z.strictObject({
  kind: z.literal("array"),
  value: z.array(z.string()).min(1),
});

const indexKeyPath = z.discriminatedUnion("kind", [stringKeyPath, arrayKeyPath]);
const keyPath = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  stringKeyPath,
  arrayKeyPath,
]);

const index = z.strictObject({
  name: z.string(),
  keyPath: indexKeyPath,
  unique: z.boolean(),
  multiEntry: z.boolean(),
});

const objectStore = z
  .strictObject({
    name: z.string(),
    keyPath,
    autoIncrement: z.boolean(),
    indexes: z.array(index),
    records: z.array(z.strictObject({ key: encodedJSON, value: encodedJSON })),
  })
  .superRefine((value, ctx) =>
    unique(
      value.indexes.map((item) => item.name),
      ctx,
    ),
  );

const database = z
  .strictObject({
    name: z.string(),
    version: z.number().int().positive().safe(),
    objectStores: z.array(objectStore),
  })
  .superRefine((value, ctx) =>
    unique(
      value.objectStores.map((item) => item.name),
      ctx,
    ),
  );

const cacheEntry = z.strictObject({
  url: httpURL,
  requestHeaders: z.record(z.string(), z.string()),
  responseHeaders: z.record(z.string(), z.string()),
  responseStatus: z.number().int().min(100).max(599),
  responseStatusText: z.string(),
  responseBody: base64,
});

const cache = z.strictObject({ name: z.string(), entries: z.array(cacheEntry) });

const opfsFile = z
  .strictObject({ path: z.string(), body: base64 })
  .refine(
    (value) =>
      value.path !== "" &&
      !value.path.startsWith("/") &&
      !value.path.endsWith("/") &&
      posix.normalize(value.path) === value.path &&
      value.path !== "." &&
      value.path !== ".." &&
      !value.path.startsWith("../"),
    "path must be a normalized relative path",
  );

const storageOrigin = z
  .strictObject({
    origin,
    ancestorOrigins: z.array(origin).max(32).optional(),
    localStorage: entries,
    indexedDB: z.array(database).optional(),
    cacheStorage: z.array(cache).optional(),
    opfs: z.array(opfsFile).optional(),
  })
  .superRefine((value, ctx) => {
    unique(value.indexedDB?.map((item) => item.name) ?? [], ctx);
    unique(value.cacheStorage?.map((item) => item.name) ?? [], ctx);
    unique(value.opfs?.map((item) => item.path) ?? [], ctx);
  });

const cookie = z
  .strictObject({
    name: z.string().refine((value) => value.trim().length > 0),
    value: z.string(),
    domain: z.string().refine((value) => value.trim().length > 0),
    path: z.string().startsWith("/"),
    hostOnly: z.boolean().optional(),
    expires: z.number().finite().positive().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
    partitionKey: z
      .strictObject({ topLevelSite: origin, hasCrossSiteAncestor: z.boolean().optional() })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.hostOnly) return;
    if (value.domain.startsWith("."))
      issue(ctx, "host-only cookie domain must not start with a dot");

    try {
      const parsed = new URL(`http://${value.domain}/`);
      if (
        parsed.host.toLowerCase() !== value.domain.toLowerCase() ||
        !parsed.hostname ||
        parsed.port ||
        parsed.pathname !== "/"
      )
        issue(ctx, "host-only cookie domain must be a valid hostname");
    } catch {
      issue(ctx, "host-only cookie domain must be a valid hostname");
    }
  });

const storageState = z
  .strictObject({ cookies: z.array(cookie).max(10000), origins: z.array(storageOrigin).max(100) })
  .superRefine((value, ctx) => {
    unique(
      value.cookies.map((item) =>
        [
          item.name,
          item.domain.toLowerCase(),
          item.path,
          item.partitionKey?.topLevelSite.toLowerCase() ?? "",
          item.partitionKey == null ? "" : String(item.partitionKey.hasCrossSiteAncestor ?? false),
        ].join("\0"),
      ),
      ctx,
    );

    unique(
      value.origins.map((item) =>
        [canonicalOrigin(item.origin), ...(item.ancestorOrigins ?? []).map(canonicalOrigin)].join(
          "\0",
        ),
      ),
      ctx,
    );
  });

const target = z
  .strictObject({
    url: httpURL,
    sessionStorage: z.array(z.strictObject({ origin, entries })).optional(),
    scroll: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional(),
    documentState: documentState.optional(),
    openerTargetIndex: nonNegative.optional(),
    active: z.boolean().optional(),
  })
  .superRefine((value, ctx) =>
    unique(value.sessionStorage?.map((item) => canonicalOrigin(item.origin)) ?? [], ctx),
  );

export const capsuleSchema = z
  .strictObject({
    initialTargets: z.array(target).max(50).optional(),
    storageState: storageState.optional(),
  })
  .superRefine((value, ctx) => {
    const targets = value.initialTargets ?? [];
    if (targets.filter((item) => item.active).length > 1)
      issue(ctx, "initialTargets must contain at most one active target");

    targets.forEach(({ openerTargetIndex: opener }, index) => {
      if (opener != null && (opener >= targets.length || opener === index))
        issue(ctx, `initialTargets[${index}].openerTargetIndex is invalid`);
    });

    // Every target has at most one opener, so a chain longer than the list must loop.
    const cyclic = targets.some((_, start) => {
      let current: number | undefined = start;
      for (let steps = 0; current != null; steps++) {
        if (steps > targets.length) return true;
        current = targets[current]?.openerTargetIndex;
      }
      return false;
    });
    if (cyclic) issue(ctx, "initialTargets opener relationships must not contain a cycle");
  });

export type Capsule = z.infer<typeof capsuleSchema>;
export type StorageOrigin = NonNullable<Capsule["storageState"]>["origins"][number];
export type Target = NonNullable<Capsule["initialTargets"]>[number];

export function canonicalOrigin(value: string): string | null {
  if (!/^https?:\/\/[^/?#]+$/i.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || !parsed.hostname) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Returns the canonical HTTP(S) origin of a URL, or null for anything else (e.g. about:blank). */
export function urlOrigin(url: string): string | null {
  return URL.canParse(url) ? canonicalOrigin(new URL(url).origin) : null;
}

function validJSON(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function issue(ctx: z.RefinementCtx, message: string): void {
  ctx.addIssue({ code: "custom", message });
}

function unique(values: readonly (string | null)[], ctx: z.RefinementCtx): void {
  const seen = new Set<string | null>();
  for (const value of values) {
    if (seen.has(value)) {
      issue(ctx, "duplicate entry");
      return;
    }
    seen.add(value);
  }
}
