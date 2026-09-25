import { CreateSessionInput } from "@aperture-browser/api-schema";
import * as Schema from "effect/Schema";

// Structure and simple limits come from api/openapi.yaml through @aperture-browser/api-schema.
// The checks below cover the rules OpenAPI cannot express.
export const Capsule = Schema.Struct({
  initialTargets: CreateSessionInput.fields.initialTargets,
  storageState: CreateSessionInput.fields.storageState,
}).check(
  Schema.makeFilter((capsule) => {
    const issues: { path: Path; issue: string }[] = [];
    const check: Check = (ok, path, message) => {
      if (!ok) issues.push({ path, issue: message });
    };
    checkTargets(capsule.initialTargets ?? [], check);
    if (capsule.storageState) checkStorageState(capsule.storageState, check);
    return issues;
  }),
);

export type Capsule = typeof Capsule.Type;
export type Target = NonNullable<Capsule["initialTargets"]>[number];
type DocumentState = NonNullable<Target["documentState"]>;
type StorageState = NonNullable<Capsule["storageState"]>;
export type StorageOrigin = StorageState["origins"][number];

type Path = readonly (string | number)[];
type Check = (ok: boolean, path: Path, message: string) => void;

const maxDocumentStateBytes = 32 * 1024 * 1024;
const httpURLMessage = "must be an absolute http or https URL without embedded credentials";
const originMessage = "must contain only an http or https scheme and host";
const jsonMessage = "must contain valid structured-clone JSON";
const base64Message = "must be valid base64";

function checkTargets(targets: readonly Target[], check: Check): void {
  check(
    targets.filter((target) => target.active).length <= 1,
    ["initialTargets"],
    "at most one target may be active",
  );

  targets.forEach((target, index) => {
    const path = ["initialTargets", index];
    check(isHTTPURL(target.url), [...path, "url"], httpURLMessage);

    const opener = target.openerTargetIndex;
    check(
      opener == null || (opener < targets.length && opener !== index),
      [...path, "openerTargetIndex"],
      "must reference another initial target",
    );

    const sessionStorage = target.sessionStorage ?? [];
    sessionStorage.forEach((state, storageIndex) => {
      const storagePath = [...path, "sessionStorage", storageIndex];
      check(canonicalOrigin(state.origin) !== null, [...storagePath, "origin"], originMessage);
      checkUnique(
        state.entries.map((entry) => entry.name),
        [...storagePath, "entries"],
        check,
      );
    });
    checkUnique(
      sessionStorage.map((state) => canonicalOrigin(state.origin)),
      [...path, "sessionStorage"],
      check,
    );

    if (target.documentState) {
      checkDocumentState(target.documentState, [...path, "documentState"], check);
    }
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
  check(!cyclic, ["initialTargets"], "opener relationships must not contain a cycle");
}

function checkDocumentState(state: DocumentState, path: Path, check: Check): void {
  check(
    new TextEncoder().encode(JSON.stringify(state)).byteLength <= maxDocumentStateBytes,
    path,
    "must not exceed 32 MiB",
  );
  check(
    state.historyState === undefined || isJSON(state.historyState),
    [...path, "historyState"],
    jsonMessage,
  );
  state.controls.forEach((control, index) => {
    check(
      !control.selection || control.selection.start <= control.selection.end,
      [...path, "controls", index, "selection"],
      "selection range is reversed",
    );
  });
}

function checkStorageState(storage: StorageState, check: Check): void {
  storage.cookies.forEach((cookie, index) => {
    const path = ["storageState", "cookies", index];
    check(cookie.name.trim() !== "", [...path, "name"], "must not be blank");
    check(cookie.domain.trim() !== "", [...path, "domain"], "must not be blank");
    check(
      !cookie.hostOnly || isHostname(cookie.domain),
      [...path, "domain"],
      "host-only cookie domain must be a plain hostname",
    );
    check(
      !cookie.partitionKey || canonicalOrigin(cookie.partitionKey.topLevelSite) !== null,
      [...path, "partitionKey", "topLevelSite"],
      originMessage,
    );
  });
  checkUnique(
    storage.cookies.map((cookie) =>
      [
        cookie.name,
        cookie.domain.toLowerCase(),
        cookie.path,
        cookie.partitionKey?.topLevelSite.toLowerCase() ?? "",
        cookie.partitionKey ? String(cookie.partitionKey.hasCrossSiteAncestor ?? false) : "",
      ].join("\0"),
    ),
    ["storageState", "cookies"],
    check,
  );

  storage.origins.forEach((origin, index) => {
    checkStorageOrigin(origin, ["storageState", "origins", index], check);
  });
  checkUnique(
    storage.origins.map((origin) =>
      [origin.origin, ...(origin.ancestorOrigins ?? [])].map(canonicalOrigin).join("\0"),
    ),
    ["storageState", "origins"],
    check,
  );
}

function checkStorageOrigin(origin: StorageOrigin, path: Path, check: Check): void {
  check(canonicalOrigin(origin.origin) !== null, [...path, "origin"], originMessage);
  origin.ancestorOrigins?.forEach((ancestor, index) => {
    check(canonicalOrigin(ancestor) !== null, [...path, "ancestorOrigins", index], originMessage);
  });
  checkUnique(
    origin.localStorage.map((entry) => entry.name),
    [...path, "localStorage"],
    check,
  );

  const databases = origin.indexedDB ?? [];
  databases.forEach((database, databaseIndex) => {
    const databasePath = [...path, "indexedDB", databaseIndex];
    database.objectStores.forEach((store, storeIndex) => {
      const storePath = [...databasePath, "objectStores", storeIndex];
      check(
        validKeyPath(store.keyPath),
        [...storePath, "keyPath"],
        "string key paths need one value, array key paths at least one, none no value",
      );
      store.indexes.forEach((index, indexIndex) => {
        check(
          validKeyPath(index.keyPath),
          [...storePath, "indexes", indexIndex, "keyPath"],
          "string key paths need exactly one value",
        );
      });
      checkUnique(
        store.indexes.map((index) => index.name),
        [...storePath, "indexes"],
        check,
      );
      store.records.forEach((record, recordIndex) => {
        const recordPath = [...storePath, "records", recordIndex];
        check(isJSON(record.key), [...recordPath, "key"], jsonMessage);
        check(isJSON(record.value), [...recordPath, "value"], jsonMessage);
      });
    });
    checkUnique(
      database.objectStores.map((store) => store.name),
      [...databasePath, "objectStores"],
      check,
    );
  });
  checkUnique(
    databases.map((database) => database.name),
    [...path, "indexedDB"],
    check,
  );

  const caches = origin.cacheStorage ?? [];
  caches.forEach((cache, cacheIndex) => {
    cache.entries.forEach((entry, entryIndex) => {
      const entryPath = [...path, "cacheStorage", cacheIndex, "entries", entryIndex];
      check(isHTTPURL(entry.url), [...entryPath, "url"], httpURLMessage);
      check(isBase64(entry.responseBody), [...entryPath, "responseBody"], base64Message);
    });
  });
  checkUnique(
    caches.map((cache) => cache.name),
    [...path, "cacheStorage"],
    check,
  );

  const files = origin.opfs ?? [];
  files.forEach((file, index) => {
    check(
      isRelativePath(file.path),
      [...path, "opfs", index, "path"],
      "must be a normalized relative path",
    );
    check(isBase64(file.body), [...path, "opfs", index, "body"], base64Message);
  });
  checkUnique(
    files.map((file) => file.path),
    [...path, "opfs"],
    check,
  );
}

function checkUnique(values: readonly (string | null)[], path: Path, check: Check): void {
  const duplicate = values.findIndex((value, index) => values.indexOf(value) !== index);
  check(duplicate === -1, [...path, duplicate], "duplicate entry");
}

function validKeyPath(keyPath: { kind: string; value?: readonly string[] }): boolean {
  const length = keyPath.value?.length;
  if (keyPath.kind === "none") return length === undefined;
  if (keyPath.kind === "string") return length === 1;
  return length !== undefined && length > 0;
}

function isHTTPURL(value: string): boolean {
  if (!URL.canParse(value.trim())) return false;
  const url = new URL(value.trim());
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.hostname !== "" &&
    !url.username &&
    !url.password
  );
}

function isHostname(domain: string): boolean {
  if (domain.startsWith(".") || !URL.canParse(`http://${domain}/`)) return false;
  const url = new URL(`http://${domain}/`);
  return url.host.toLowerCase() === domain.toLowerCase() && url.hostname !== "" && !url.port;
}

function isRelativePath(path: string): boolean {
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isJSON(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

const base64 = Schema.is(Schema.String.check(Schema.isBase64()));

function isBase64(value: string): boolean {
  return base64(value.replaceAll(/\r|\n/g, ""));
}

export function canonicalOrigin(value: string): string | null {
  if (!/^https?:\/\/[^/?#]+$/i.test(value) || !URL.canParse(value)) return null;
  const url = new URL(value);
  return url.username || url.password || !url.hostname ? null : url.origin;
}

/** Returns the canonical HTTP(S) origin of a URL, or null for anything else (e.g. about:blank). */
export function urlOrigin(url: string): string | null {
  return URL.canParse(url) ? canonicalOrigin(new URL(url).origin) : null;
}
