import { sessionFileRootDirectories, type SessionFileEntry } from "@aperture-browser/api-client";

const sizeUnits = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < sizeUnits.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${sizeUnits[unit]}`;
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const shortDateWithYear = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});
const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** A compact age for a row: `now`, `5m`, `3h`, `2d`, then the date. */
export function formatShortAge(date: Date, now = Date.now()): string {
  const elapsed = Math.max(0, now - date.getTime());
  if (elapsed < minute) return "now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}d`;
  return new Date(now).getFullYear() === date.getFullYear()
    ? shortDate.format(date)
    : shortDateWithYear.format(date);
}

export function formatFullDate(date: Date): string {
  return fullDate.format(date);
}

export function joinPath(directory: string, name: string): string {
  return directory === "" ? name : `${directory}/${name}`;
}

export function parentPath(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

export function baseName(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

/** The path with spaces around its last segment removed, as typed names are validated. */
export function trimBaseName(relativePath: string): string {
  return joinPath(parentPath(relativePath), baseName(relativePath).trim());
}

/** The fixed top-level directories cannot be deleted, moved or renamed. */
export function isRootDirectory(relativePath: string): boolean {
  return (sessionFileRootDirectories as ReadonlyArray<string>).includes(relativePath);
}

/** A name for a new entry: one path segment, no traversal. */
export function validateEntryName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Enter a name";
  if (trimmed.includes("/") || trimmed.includes("\\")) return "Names cannot contain slashes";
  if (trimmed === "." || trimmed === "..") return "Choose another name";
  return null;
}

/*
 * The tree identifies entries by path, marking directories with a trailing slash
 * (`uploads/invoices/`) so empty ones still show as folders. The API uses plain relative
 * paths (`uploads/invoices`).
 */

export function toTreeDirectory(relativePath: string): string {
  return `${relativePath}/`;
}

export function isTreeDirectory(treePath: string): boolean {
  return treePath.endsWith("/");
}

/** The API path of a tree path, file or directory. */
export function fromTreePath(treePath: string): string {
  return isTreeDirectory(treePath) ? treePath.slice(0, -1) : treePath;
}

/** Every entry as a tree path, the fixed top-level directories always included. */
export function treePaths(entries: ReadonlyArray<SessionFileEntry>): Array<string> {
  const paths = new Set(sessionFileRootDirectories.map(toTreeDirectory));
  for (const entry of entries) {
    paths.add(
      entry.type === "directory" ? toTreeDirectory(entry.relativePath) : entry.relativePath,
    );
  }
  return [...paths];
}

/** Changes whenever an entry is added, removed, resized or touched. */
export function entriesSignature(entries: ReadonlyArray<SessionFileEntry>): string {
  return entries
    .map((entry) =>
      entry.type === "file"
        ? `f:${entry.relativePath}:${entry.size}:${entry.modifiedAt}`
        : `d:${entry.relativePath}:${entry.modifiedAt}`,
    )
    .sort()
    .join("\n");
}

/** `name`, or `name 2`, `name 3`… when a sibling already uses it. */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  for (let index = 2; ; index += 1) {
    const candidate = `${name} ${index}`;
    if (!taken(candidate)) return candidate;
  }
}

export function errorMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return fallback;
}
