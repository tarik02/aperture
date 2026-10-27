import {
  sessionFileRootDirectories,
  sessionFileTree,
  type SessionFileEntry,
  type SessionFileTreeNode,
} from "@aperture-browser/api-client";

export type SessionFileKind =
  | "directory"
  | "video"
  | "image"
  | "audio"
  | "archive"
  | "text"
  | "file";

const videoExtensions = new Set(["mp4", "webm", "mkv", "mov", "avi", "m4v", "ogv"]);
const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);
const audioExtensions = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"]);
const archiveExtensions = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "zst"]);
const textExtensions = new Set(["txt", "md", "log", "json", "csv", "yaml", "yml", "xml", "html"]);

/** The kind of a file as far as its icon is concerned, judged by its extension. */
export function fileKind(name: string): Exclude<SessionFileKind, "directory"> {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (videoExtensions.has(extension)) return "video";
  if (imageExtensions.has(extension)) return "image";
  if (audioExtensions.has(extension)) return "audio";
  if (archiveExtensions.has(extension)) return "archive";
  if (textExtensions.has(extension)) return "text";
  return "file";
}

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

export function joinPath(directory: string, name: string): string {
  return directory === "" ? name : `${directory}/${name}`;
}

export function parentPath(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash);
}

/** Every ancestor of `relativePath` from the top down, the path itself included. */
export function pathCrumbs(relativePath: string): Array<{ name: string; path: string }> {
  if (relativePath === "") return [];
  const segments = relativePath.split("/");
  return segments.map((name, index) => ({
    name,
    path: segments.slice(0, index + 1).join("/"),
  }));
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

/**
 * The entries directly inside `directory`, directories first and then files by name, or
 * `null` when the directory does not exist in the listing.
 */
export function directoryChildren(
  entries: ReadonlyArray<SessionFileEntry>,
  directory: string,
): ReadonlyArray<SessionFileTreeNode> | null {
  let nodes = sessionFileTree(entries);
  for (const crumb of pathCrumbs(directory)) {
    const next = nodes.find(
      (node) => node.kind === "directory" && node.relativePath === crumb.path,
    );
    if (next === undefined || next.kind !== "directory") return null;
    nodes = next.children;
  }
  return nodes;
}

/** The deepest ancestor of `directory`, itself included, that the listing still contains. */
export function nearestExistingDirectory(
  entries: ReadonlyArray<SessionFileEntry>,
  directory: string,
): string {
  let candidate = directory;
  while (candidate !== "" && directoryChildren(entries, candidate) === null) {
    candidate = parentPath(candidate);
  }
  return candidate;
}

export function errorMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return fallback;
}
