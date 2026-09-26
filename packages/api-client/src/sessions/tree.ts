import type { SessionDirectory, SessionFile, SessionFileEntry } from "../schemas.ts";

/**
 * The top-level directories the session writes into. They always exist and cannot be
 * deleted, moved or renamed.
 */
export const sessionFileRootDirectories = [
  "downloads",
  "recordings",
  "uploads",
  "outputs",
] as const;

export interface SessionFileDirectoryNode {
  readonly kind: "directory";
  readonly name: string;
  readonly relativePath: string;
  /** Absent for a directory known only from the paths of legacy files. */
  readonly directory: SessionDirectory | undefined;
  readonly children: ReadonlyArray<SessionFileTreeNode>;
}

export interface SessionFileNode {
  readonly kind: "file";
  readonly name: string;
  readonly relativePath: string;
  readonly file: SessionFile;
}

export type SessionFileTreeNode = SessionFileDirectoryNode | SessionFileNode;

interface DirectoryBuilder {
  directory: SessionDirectory | undefined;
  readonly directories: Map<string, DirectoryBuilder>;
  readonly files: Array<SessionFileNode>;
}

const emptyDirectory = (): DirectoryBuilder => ({
  directory: undefined,
  directories: new Map(),
  files: [],
});

function directoryAt(root: DirectoryBuilder, segments: ReadonlyArray<string>): DirectoryBuilder {
  let directory = root;
  for (const segment of segments) {
    let child = directory.directories.get(segment);
    if (child === undefined) {
      child = emptyDirectory();
      directory.directories.set(segment, child);
    }
    directory = child;
  }
  return directory;
}

function toNodes(directory: DirectoryBuilder, parentPath: string): Array<SessionFileTreeNode> {
  const directories = [...directory.directories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, child]): SessionFileDirectoryNode => {
      const relativePath = parentPath === "" ? name : `${parentPath}/${name}`;
      return {
        kind: "directory",
        name,
        relativePath,
        directory: child.directory,
        children: toNodes(child, relativePath),
      };
    });
  const files = [...directory.files].sort((left, right) => left.name.localeCompare(right.name));
  return [...directories, ...files];
}

/**
 * Arranges `listSessionFiles` results into a tree: directories first, then files, each
 * sorted by name. Empty directories appear because the listing includes them.
 */
export function sessionFileTree(
  entries: ReadonlyArray<SessionFileEntry>,
): ReadonlyArray<SessionFileTreeNode> {
  const root = emptyDirectory();
  for (const entry of entries) {
    const segments = entry.relativePath.split("/");
    if (entry.type === "directory") {
      directoryAt(root, segments).directory = entry;
      continue;
    }
    const name = segments.pop() ?? entry.relativePath;
    directoryAt(root, segments).files.push({
      kind: "file",
      name,
      relativePath: entry.relativePath,
      file: entry,
    });
  }
  return toNodes(root, "");
}
