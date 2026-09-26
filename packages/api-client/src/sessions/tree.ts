import type { SessionFile } from "../schemas.ts";

/** The directories below every session's files root, which exist even when empty. */
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
  readonly directories: Map<string, DirectoryBuilder>;
  readonly files: Array<SessionFileNode>;
}

const emptyDirectory = (): DirectoryBuilder => ({ directories: new Map(), files: [] });

function toNodes(directory: DirectoryBuilder, parentPath: string): Array<SessionFileTreeNode> {
  const directories = [...directory.directories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, child]): SessionFileDirectoryNode => {
      const relativePath = parentPath === "" ? name : `${parentPath}/${name}`;
      return { kind: "directory", name, relativePath, children: toNodes(child, relativePath) };
    });
  const files = [...directory.files].sort((left, right) => left.name.localeCompare(right.name));
  return [...directories, ...files];
}

/**
 * Arranges `listSessionFiles` results into a tree: directories first, then files, each
 * sorted by name. The listing holds only files, so directories are derived from their
 * paths, and the top-level `sessionFileRootDirectories` are always present.
 */
export function sessionFileTree(
  files: ReadonlyArray<SessionFile>,
): ReadonlyArray<SessionFileTreeNode> {
  const root = emptyDirectory();
  for (const name of sessionFileRootDirectories) {
    root.directories.set(name, emptyDirectory());
  }
  for (const file of files) {
    const segments = file.relativePath.split("/");
    const name = segments.pop() ?? file.relativePath;
    let directory = root;
    for (const segment of segments) {
      let child = directory.directories.get(segment);
      if (child === undefined) {
        child = emptyDirectory();
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.files.push({ kind: "file", name, relativePath: file.relativePath, file });
  }
  return toNodes(root, "");
}
