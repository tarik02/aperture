import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTree as FileTreeModel,
  FileTreeDirectoryHandle,
  FileTreeDropResult,
  FileTreeItemHandle,
  FileTreeRenameEvent,
  FileTreeRowDecoration,
} from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSelection } from "@pierre/trees/react";
import { Copy, Download, FolderPlus, Pencil, Trash2, Upload, type LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { toast } from "sonner";
import type { Session, SessionFileEntry } from "@aperture-browser/api-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@aperture-browser/ui/components/dropdown-menu";
import { usePortalContainer } from "@aperture-browser/ui/portal";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import {
  useCreateSessionDirectoryMutation,
  useDeleteSessionFileMutation,
  useDownloadSessionFile,
  useMoveSessionFileMutation,
  useSessionFilesQuery,
  useUploadSessionFileMutation,
} from "./session-files.queries.ts";
import { treeIcons, treeItemHeight, treeThemeStyle } from "./session-files-tree.ts";
import {
  baseName,
  entriesSignature,
  errorMessage,
  formatBytes,
  formatFullDate,
  formatShortAge,
  fromTreePath,
  isRootDirectory,
  isTreeDirectory,
  joinPath,
  parentPath,
  toTreeDirectory,
  treePaths,
  uniqueName,
  validateEntryName,
} from "./session-files.utils.ts";

type PendingUpload = { id: string; name: string; directory: string };

/** Something being deleted, waiting for confirmation. */
type Deleting = { relativePath: string; directory: boolean };

/** An OS file drag over the panel: where a drop would upload to, and the row to outline. */
type DropTarget = {
  /** The folder the files would be stored in; `undefined` is the server default, `uploads`. */
  directory: string | undefined;
  highlight: { top: number; left: number; width: number; height: number } | null;
};

/** A tree row found from a DOM event inside the tree's shadow root. */
type EventRow = { path: string; kind: "file" | "folder"; element: HTMLElement };

/** Callbacks the tree model calls; replaced every render so they see current state. */
type TreeHandlers = {
  rename: (event: FileTreeRenameEvent) => void;
  drop: (result: FileTreeDropResult) => void;
  decorate: (item: ContextMenuItem) => FileTreeRowDecoration | null;
};

const defaultUploadDirectory = "uploads";
const ageRefreshMs = 60_000;

/**
 * The files of one session: downloads, recordings, uploads and tool output, as an expandable
 * tree. Downloads files on click; renames, moves (by dragging), deletes and creates folders;
 * uploads files picked or dropped from the desktop onto the panel or onto a folder.
 * Fills its parent; the caller provides the container.
 */
export function SessionFilesPanel({ session }: { session: Session }) {
  // A new session starts with a fresh tree: no expanded folders, selection or drafts.
  return <SessionFilesTreePanel key={session.id} sessionId={session.id} />;
}

function SessionFilesTreePanel({ sessionId }: { sessionId: string }) {
  const query = useSessionFilesQuery(sessionId);
  const upload = useUploadSessionFileMutation(sessionId);
  const createDirectory = useCreateSessionDirectoryMutation(sessionId);
  const move = useMoveSessionFileMutation(sessionId);
  const remove = useDeleteSessionFileMutation(sessionId);
  const download = useDownloadSessionFile(sessionId);
  const { resolvedTheme } = useTheme();

  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Where files picked with the file input go; set by whoever opens the picker. */
  const pickerDirectory = useRef<string | undefined>(undefined);
  const uploadSequence = useRef(0);

  /** The listing the tree shows, by relative path, for row decorations. */
  const shownEntries = useRef(new Map<string, SessionFileEntry>());
  const shownSignature = useRef<string | null>(null);
  /** A listing arrived while a rename was in progress and waits for it to end. */
  const syncDeferred = useRef(false);
  /** The tree path of the folder being named by "New folder", before it exists. */
  const draftFolder = useRef<string | null>(null);
  const renameWatch = useRef<number | null>(null);

  const handlers = useRef<TreeHandlers | null>(null);

  const { model } = useFileTree({
    paths: treePaths([]),
    initialExpansion: "closed",
    flattenEmptyDirectories: false,
    stickyFolders: true,
    itemHeight: treeItemHeight,
    icons: treeIcons,
    composition: {
      contextMenu: { enabled: true, triggerMode: "both", buttonVisibility: "when-needed" },
    },
    renaming: {
      canRename: (item) => !isRootDirectory(item.path),
      onRename: (event) => handlers.current?.rename(event),
      onError: (error) => toast.error("Could not rename", { description: error }),
    },
    dragAndDrop: {
      canDrag: (paths) => paths.every((path) => !isRootDirectory(fromTreePath(path))),
      // Only into a folder, and not where the entries already are.
      canDrop: ({ draggedPaths, target }) =>
        target.kind === "directory" &&
        target.directoryPath !== null &&
        draggedPaths.every((path) => treeParent(path) !== target.directoryPath),
      onDropComplete: (result) => handlers.current?.drop(result),
      onDropError: (error) => toast.error("Could not move", { description: error }),
    },
    renderRowDecoration: ({ item }) => handlers.current?.decorate(item) ?? null,
  });

  const selectedPaths = useFileTreeSelection(model);
  const selectedDirectory = directoryOfSelection(selectedPaths);
  const dropDefault = selectedDirectory;

  /** Shows the latest listing in the tree, keeping expanded folders, selection and focus. */
  const sync = useCallback(
    (force = false) => {
      const entries = query.data;
      if (entries === undefined) return;
      const signature = entriesSignature(entries);
      if (!force && signature === shownSignature.current) return;
      // Replacing the paths would drop a draft folder or end a rename midway.
      if (draftFolder.current !== null || isRenaming(model)) {
        syncDeferred.current = true;
        return;
      }
      syncDeferred.current = false;
      shownEntries.current = new Map(entries.map((entry) => [entry.relativePath, entry]));
      shownSignature.current = signature;
      const paths = treePaths(entries);
      model.resetPaths(paths, { initialExpandedPaths: expandedDirectories(model, paths) });
    },
    [model, query.data],
  );

  useEffect(() => {
    sync();
  }, [sync, query.dataUpdatedAt]);

  // Ages like "5m" go stale between listings; redraw the rows now and then.
  useEffect(() => {
    const timer = window.setInterval(() => sync(true), ageRefreshMs);
    return () => window.clearInterval(timer);
  }, [sync]);

  useEffect(
    () => () => {
      if (renameWatch.current !== null) cancelAnimationFrame(renameWatch.current);
    },
    [],
  );

  // A drag that ends outside the panel never sends it a final dragleave.
  useEffect(() => {
    const reset = () => {
      dragDepth.current = 0;
      setDrop(null);
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, []);

  /**
   * Waits for the inline rename the tree shows to close, then creates a draft folder kept
   * under its suggested name and applies listings that arrived meanwhile.
   */
  function watchRename() {
    if (renameWatch.current !== null) return;
    let seen = false;
    let frames = 0;
    const tick = () => {
      const active = isRenaming(model);
      seen ||= active;
      frames += 1;
      // The input appears a frame or two after the rename starts.
      if (active || (!seen && frames < 30)) {
        renameWatch.current = requestAnimationFrame(tick);
        return;
      }
      renameWatch.current = null;
      const draft = draftFolder.current;
      draftFolder.current = null;
      if (draft !== null && model.getItem(draft) !== null) {
        void createFolder(fromTreePath(draft));
      }
      if (syncDeferred.current) sync();
    };
    renameWatch.current = requestAnimationFrame(tick);
  }

  useLayoutEffect(() => {
    handlers.current = treeHandlers;
  });

  const treeHandlers: TreeHandlers = {
    rename({ sourcePath, destinationPath }) {
      const draft = draftFolder.current;
      if (draft !== null && fromTreePath(draft) === sourcePath) {
        draftFolder.current = null;
        void createFolder(destinationPath);
        return;
      }
      const invalid = validateEntryName(baseName(destinationPath));
      if (invalid !== null) {
        toast.error(`Could not rename ${baseName(sourcePath)}`, { description: invalid });
        // The tree applies the rename right after this returns; undo it afterwards.
        queueMicrotask(() => sync(true));
        return;
      }
      void moveEntries([{ from: sourcePath, to: destinationPath }], "rename");
    },
    drop({ draggedPaths, target }) {
      if (target.directoryPath === null) return;
      const directory = fromTreePath(target.directoryPath);
      void moveEntries(
        draggedPaths.map((path) => {
          const from = fromTreePath(path);
          return { from, to: joinPath(directory, baseName(from)) };
        }),
        "move",
      );
    },
    decorate(item) {
      if (item.kind !== "file") return null;
      const entry = shownEntries.current.get(item.path);
      if (entry?.type !== "file") return null;
      const modified = new Date(entry.modifiedAt);
      const size = formatBytes(entry.size);
      return {
        text: `${size} · ${formatShortAge(modified)}`,
        title: `${size} · modified ${formatFullDate(modified)}`,
      };
    },
  };

  /** Saves moves the tree already shows, restoring the listing if any fails. */
  async function moveEntries(
    moves: ReadonlyArray<{ from: string; to: string }>,
    action: "rename" | "move",
  ) {
    const failures: Array<{ name: string; error: unknown }> = [];
    for (const item of moves) {
      try {
        await move.mutateAsync(item);
      } catch (error) {
        failures.push({ name: baseName(item.from), error });
      }
    }
    if (failures.length === 0) return;
    const first = failures[0]!;
    toast.error(
      failures.length === 1
        ? `Could not ${action} ${first.name}`
        : `Could not move ${failures.length} items`,
      { description: errorMessage(first.error) },
    );
    sync(true);
  }

  async function createFolder(relativePath: string) {
    const invalid = validateEntryName(baseName(relativePath));
    if (invalid !== null) {
      toast.error("Could not create folder", { description: invalid });
      sync(true);
      return;
    }
    try {
      await createDirectory.mutateAsync(relativePath);
    } catch (error) {
      toast.error("Could not create folder", { description: errorMessage(error) });
      sync(true);
    }
  }

  /** Adds a folder to the tree inside `directory` and lets the user name it in place. */
  function startNewFolder(directory: string) {
    if (draftFolder.current !== null || isRenaming(model)) return;
    const parent = directory === "" ? "" : toTreeDirectory(directory);
    if (parent !== "") expandDirectory(model, parent);
    const name = uniqueName(
      "New folder",
      (candidate) =>
        model.getItem(`${parent}${candidate}/`) !== null ||
        model.getItem(`${parent}${candidate}`) !== null,
    );
    const draft = `${parent}${name}/`;
    try {
      model.add(draft);
    } catch (error) {
      toast.error("Could not create folder", { description: errorMessage(error) });
      return;
    }
    draftFolder.current = draft;
    if (!model.startRenaming(draft, { removeIfCanceled: true })) {
      draftFolder.current = null;
      model.remove(draft, { recursive: true });
      return;
    }
    watchRename();
  }

  function startRename(path: string) {
    if (model.startRenaming(path)) watchRename();
  }

  async function uploadFiles(files: ReadonlyArray<File>, directory: string | undefined) {
    if (files.length === 0) return;
    const where = directory ?? defaultUploadDirectory;
    const batch = files.map((file) => ({
      id: `upload-${uploadSequence.current++}`,
      name: file.name,
      directory: where,
      file,
    }));
    setPending((current) => [
      ...current,
      ...batch.map(({ id, name }) => ({ id, name, directory: where })),
    ]);
    // Show where the files land.
    expandDirectory(model, toTreeDirectory(where));
    const results = await Promise.allSettled(
      batch.map(async (item) => {
        try {
          return await upload.mutateAsync({ file: item.file, directory });
        } finally {
          setPending((current) => current.filter((entry) => entry.id !== item.id));
        }
      }),
    );
    const failures = results.filter((result) => result.status === "rejected");
    const succeeded = results.length - failures.length;
    if (failures.length === 0) {
      toast.success(
        succeeded === 1 ? `Uploaded ${batch[0]!.name}` : `Uploaded ${succeeded} files to ${where}`,
      );
    } else {
      const reason = errorMessage(failures[0]!.reason, "Upload failed");
      toast.error(
        succeeded === 0
          ? files.length === 1
            ? `Could not upload ${batch[0]!.name}`
            : `Could not upload ${files.length} files`
          : `Uploaded ${succeeded} of ${results.length} files`,
        { description: reason },
      );
    }
  }

  function pickFiles(directory: string | undefined) {
    pickerDirectory.current = directory;
    fileInput.current?.click();
  }

  async function startDownload(relativePath: string) {
    const name = baseName(relativePath);
    try {
      await download(relativePath, name);
    } catch (error) {
      toast.error(`Could not download ${name}`, { description: errorMessage(error) });
    }
  }

  async function copyPath(relativePath: string) {
    try {
      await navigator.clipboard.writeText(relativePath);
      toast.success("Copied path");
    } catch {
      toast.error("Could not copy the path");
    }
  }

  // Files open on click or Enter; folders keep the tree's own expand and collapse.
  function onTreeClick(event: MouseEvent) {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const row = rowOfEvent(event.nativeEvent);
    if (row?.kind === "file") void startDownload(row.path);
  }

  function onTreeKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter" || isRenaming(model)) return;
    const row = rowOfEvent(event.nativeEvent);
    if (row?.kind === "file") void startDownload(row.path);
  }

  /* Uploads by dropping files from the desktop onto the panel or onto a folder row. */

  function dropTargetOf(event: DragEvent): DropTarget {
    const row = rowOfEvent(event.nativeEvent);
    let directory: string | undefined;
    if (row?.kind === "folder") directory = fromTreePath(row.path);
    else if (row?.kind === "file") directory = parentPath(row.path) || dropDefault;
    else directory = dropDefault;
    const element =
      row?.kind === "folder"
        ? row.element
        : directory === undefined
          ? null
          : findRow(model, toTreeDirectory(directory));
    const container = panel.current;
    let highlight: DropTarget["highlight"] = null;
    if (element !== null && container !== null) {
      const box = element.getBoundingClientRect();
      const origin = container.getBoundingClientRect();
      highlight = {
        top: box.top - origin.top,
        left: box.left - origin.left,
        width: box.width,
        height: box.height,
      };
    }
    return { directory, highlight };
  }

  function showDropTarget(event: DragEvent) {
    const next = dropTargetOf(event);
    setDrop((current) => (current !== null && sameDropTarget(current, next) ? current : next));
  }

  function onDragEnter(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    showDropTarget(event);
  }

  function onDragOver(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    showDropTarget(event);
  }

  function onDragLeave(event: DragEvent) {
    if (!hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDrop(null);
  }

  function onDrop(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const { directory } = dropTargetOf(event);
    dragDepth.current = 0;
    setDrop(null);
    void uploadFiles(Array.from(event.dataTransfer.files), directory);
  }

  const entries = query.data;
  const empty =
    entries !== undefined &&
    pending.length === 0 &&
    entries.every((entry) => entry.type === "directory" && isRootDirectory(entry.relativePath));
  const uploadLabel = selectedDirectory ?? defaultUploadDirectory;

  return (
    <div
      ref={panel}
      className="aperture:relative aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-col aperture:bg-sidebar aperture:text-sm"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="aperture:flex aperture:h-9 aperture:shrink-0 aperture:items-center aperture:gap-1 aperture:border-b aperture:pr-1.5 aperture:pl-3">
        <span className="aperture:min-w-0 aperture:flex-1 aperture:truncate aperture:font-medium">
          Files
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Upload files"
          title={`Upload files to ${uploadLabel}`}
          onClick={() => pickFiles(selectedDirectory)}
        >
          <Upload />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New folder"
          title={selectedDirectory ? `New folder in ${selectedDirectory}` : "New folder"}
          disabled={entries === undefined}
          onClick={() => startNewFolder(selectedDirectory ?? "")}
        >
          <FolderPlus />
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void uploadFiles(files, pickerDirectory.current);
          }}
        />
      </div>

      {query.isError ? (
        <p className="aperture:shrink-0 aperture:px-3 aperture:py-2 aperture:text-xs aperture:text-muted-foreground">
          {errorMessage(query.error, "Could not load files")}
          {" · "}
          <button
            type="button"
            className="aperture:underline aperture:underline-offset-2 aperture:hover:text-foreground"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </p>
      ) : null}

      {pending.length > 0 ? (
        <ul className="aperture:grid aperture:shrink-0 aperture:gap-px aperture:border-b aperture:px-3 aperture:py-1.5 aperture:text-muted-foreground">
          {pending.map((item) => (
            <li
              key={item.id}
              className="aperture:flex aperture:h-6 aperture:items-center aperture:gap-2"
            >
              <Spinner className="aperture:size-3.5 aperture:shrink-0" />
              <span className="aperture:min-w-0 aperture:flex-1 aperture:truncate">
                {item.name}
              </span>
              <span className="aperture:max-w-24 aperture:shrink-0 aperture:truncate aperture:text-xs">
                {item.directory}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {entries === undefined ? (
        query.isError ? null : (
          <div className="aperture:flex aperture:justify-center aperture:py-6 aperture:text-muted-foreground">
            <Spinner className="aperture:size-4" />
          </div>
        )
      ) : (
        <div
          className={
            empty
              ? "aperture:shrink-0 aperture:pt-1"
              : "aperture:min-h-0 aperture:flex-1 aperture:pt-1"
          }
          // Room for the fixed folders alone, so the hint below stays close to them.
          style={empty ? { height: `${treePaths([]).length * treeItemHeight + 8}px` } : undefined}
        >
          <FileTree
            model={model}
            className="aperture:block aperture:h-full"
            style={treeThemeStyle(resolvedTheme === "dark" ? "dark" : "light")}
            onClick={onTreeClick}
            onKeyDown={onTreeKeyDown}
            renderContextMenu={(item, context) => (
              <EntryMenu
                key={item.path}
                item={item}
                context={context}
                onDownload={(path) => void startDownload(path)}
                onCopyPath={(path) => void copyPath(path)}
                onUploadHere={pickFiles}
                onNewFolder={startNewFolder}
                onRename={startRename}
                onDelete={setDeleting}
              />
            )}
          />
        </div>
      )}

      {empty && !query.isError ? (
        <div className="aperture:grid aperture:gap-1 aperture:px-4 aperture:py-6 aperture:text-center aperture:text-muted-foreground">
          <p>No files yet. Downloads, recordings and uploads appear here.</p>
          <p className="aperture:text-xs aperture:text-muted-foreground/70">Drop files to upload</p>
        </div>
      ) : null}

      {drop ? (
        <>
          <div className="aperture:pointer-events-none aperture:absolute aperture:inset-1 aperture:z-10 aperture:rounded-lg aperture:border-2 aperture:border-dashed aperture:border-primary/40" />
          {drop.highlight ? (
            <div
              className="aperture:pointer-events-none aperture:absolute aperture:z-10 aperture:rounded-md aperture:bg-primary/10 aperture:ring-1 aperture:ring-primary/60"
              style={drop.highlight}
            />
          ) : null}
          <div className="aperture:pointer-events-none aperture:absolute aperture:inset-x-3 aperture:bottom-3 aperture:z-10 aperture:flex aperture:items-center aperture:justify-center aperture:gap-2 aperture:rounded-md aperture:bg-popover aperture:px-3 aperture:py-2 aperture:text-muted-foreground aperture:shadow-md aperture:ring-1 aperture:ring-foreground/10">
            <Upload className="aperture:size-4 aperture:shrink-0" />
            <span className="aperture:min-w-0 aperture:truncate">
              Drop to upload to{" "}
              <span className="aperture:font-medium aperture:text-foreground">
                {drop.directory ?? defaultUploadDirectory}
              </span>
            </span>
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={deleting?.directory ? "Delete folder?" : "Delete file?"}
        description={
          deleting?.directory
            ? `${deleting.relativePath} and everything inside it will be deleted.`
            : `${deleting?.relativePath ?? ""} will be deleted.`
        }
        confirmLabel="Delete"
        variant="destructive"
        pending={remove.isPending}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onConfirm={async () => {
          if (deleting === null) return;
          try {
            await remove.mutateAsync({
              relativePath: deleting.relativePath,
              recursive: deleting.directory,
            });
          } catch (error) {
            toast.error(`Could not delete ${baseName(deleting.relativePath)}`, {
              description: errorMessage(error),
            });
            throw error;
          }
        }}
      />
    </div>
  );
}

/**
 * The actions of one row, opened by right-clicking it or with its ⋯ button. The tree owns
 * opening and closing; this anchors a menu to the spot it reports.
 */
function EntryMenu({
  item,
  context,
  onDownload,
  onCopyPath,
  onUploadHere,
  onNewFolder,
  onRename,
  onDelete,
}: {
  item: ContextMenuItem;
  context: ContextMenuOpenContext;
  onDownload: (relativePath: string) => void;
  onCopyPath: (relativePath: string) => void;
  onUploadHere: (directory: string) => void;
  onNewFolder: (directory: string) => void;
  onRename: (treePath: string) => void;
  onDelete: (deleting: Deleting) => void;
}) {
  const container = usePortalContainer();
  const relativePath = fromTreePath(item.path);
  const directory = item.kind === "directory";
  const fixed = directory && isRootDirectory(relativePath);
  // Set when an action closes the menu itself, so closing does not happen twice.
  const closed = useRef(false);

  function run(action: () => void, restoreFocus = true) {
    return () => {
      closed.current = true;
      context.close({ restoreFocus });
      action();
    };
  }

  const entries: Array<
    { icon: LucideIcon; label: string; onClick: () => void; destructive?: boolean } | "separator"
  > = directory
    ? [
        { icon: Upload, label: "Upload here", onClick: run(() => onUploadHere(relativePath)) },
        {
          icon: FolderPlus,
          label: "New folder",
          onClick: run(() => onNewFolder(relativePath), false),
        },
        { icon: Copy, label: "Copy path", onClick: run(() => onCopyPath(relativePath)) },
      ]
    : [
        { icon: Download, label: "Download", onClick: run(() => onDownload(relativePath)) },
        { icon: Copy, label: "Copy path", onClick: run(() => onCopyPath(relativePath)) },
      ];
  if (!fixed) {
    entries.push(
      { icon: Pencil, label: "Rename", onClick: run(() => onRename(item.path), false) },
      "separator",
      {
        icon: Trash2,
        label: "Delete",
        destructive: true,
        onClick: run(() => onDelete({ relativePath, directory })),
      },
    );
  }

  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open && !closed.current) {
          closed.current = true;
          context.close();
        }
      }}
    >
      <MenuPrimitive.Portal container={container}>
        <MenuPrimitive.Positioner
          // The rect the tree reports; its anchor element sits in a shadow root the positioner
          // measures wrongly.
          anchor={{
            getBoundingClientRect: () =>
              DOMRect.fromRect({
                x: context.anchorRect.x,
                y: context.anchorRect.y,
                width: context.anchorRect.width,
                height: context.anchorRect.height,
              }),
          }}
          side="bottom"
          align="start"
          sideOffset={4}
          className="aperture:isolate aperture:z-50 aperture:outline-none"
        >
          <MenuPrimitive.Popup
            // Tells the tree that presses inside this portaled menu are not outside clicks.
            data-file-tree-context-menu-root="true"
            aria-label={`Actions for ${item.name}`}
            className="aperture:z-50 aperture:max-h-(--available-height) aperture:min-w-40 aperture:origin-(--transform-origin) aperture:overflow-x-hidden aperture:overflow-y-auto aperture:rounded-lg aperture:bg-popover aperture:p-1 aperture:text-popover-foreground aperture:shadow-md aperture:ring-1 aperture:ring-foreground/10 aperture:outline-none aperture:data-open:animate-in aperture:data-open:fade-in-0"
          >
            {entries.map((entry, index) =>
              entry === "separator" ? (
                <DropdownMenuSeparator key={`separator-${index}`} />
              ) : (
                <DropdownMenuItem
                  key={entry.label}
                  variant={entry.destructive ? "destructive" : "default"}
                  onClick={entry.onClick}
                >
                  <entry.icon />
                  {entry.label}
                </DropdownMenuItem>
              ),
            )}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </DropdownMenu>
  );
}

function hasFiles(event: DragEvent) {
  return event.dataTransfer.types.includes("Files");
}

function sameDropTarget(left: DropTarget, right: DropTarget) {
  const a = left.highlight;
  const b = right.highlight;
  return (
    left.directory === right.directory &&
    (a === b ||
      (a !== null &&
        b !== null &&
        a.top === b.top &&
        a.left === b.left &&
        a.width === b.width &&
        a.height === b.height))
  );
}

/** The row an event happened on, looking through the tree's shadow root. */
function rowOfEvent(event: Event): EventRow | null {
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    // The row's ⋯ button and the rename field act on their own.
    if (node.dataset.type === "context-menu-trigger" || "itemRenameInput" in node.dataset) {
      return null;
    }
    if (node.dataset.type === "item") {
      const path = node.dataset.itemPath;
      if (path === undefined) return null;
      return {
        path: fromTreePath(path),
        kind: node.dataset.itemType === "folder" ? "folder" : "file",
        element: node,
      };
    }
    if (node.tagName === "FILE-TREE-CONTAINER") break;
  }
  return null;
}

/** The mounted row of a folder, if it is scrolled into view. */
function findRow(model: FileTreeModel, treePath: string): HTMLElement | null {
  const root = model.getFileTreeContainer()?.shadowRoot;
  const selector = [treePath, fromTreePath(treePath)]
    .map((path) => `[data-type="item"][data-item-path="${CSS.escape(path)}"]`)
    .join(", ");
  return root?.querySelector<HTMLElement>(selector) ?? null;
}

function isRenaming(model: FileTreeModel) {
  return (
    model.getFileTreeContainer()?.shadowRoot?.querySelector("[data-item-rename-input]") != null
  );
}

function directoryHandle(model: FileTreeModel, treePath: string): FileTreeDirectoryHandle | null {
  const item = model.getItem(treePath);
  return item !== null && isDirectoryHandle(item) ? item : null;
}

function isDirectoryHandle(item: FileTreeItemHandle): item is FileTreeDirectoryHandle {
  return item.isDirectory();
}

function expandDirectory(model: FileTreeModel, treePath: string) {
  const item = directoryHandle(model, treePath);
  if (item !== null && !item.isExpanded()) item.expand();
}

/** The directories among `paths` currently expanded in the tree. */
function expandedDirectories(model: FileTreeModel, paths: ReadonlyArray<string>) {
  return paths.filter(
    (path) => isTreeDirectory(path) && directoryHandle(model, path)?.isExpanded() === true,
  );
}

/** The tree path of the folder containing `treePath`, `""` at the top. */
function treeParent(treePath: string) {
  const parent = parentPath(fromTreePath(treePath));
  return parent === "" ? "" : toTreeDirectory(parent);
}

/** The selected folder, or the folder of the selected file, for uploads and new folders. */
function directoryOfSelection(selectedPaths: ReadonlyArray<string>): string | undefined {
  const last = selectedPaths.at(-1);
  if (last === undefined) return undefined;
  const directory = isTreeDirectory(last) ? fromTreePath(last) : parentPath(last);
  return directory === "" ? undefined : directory;
}
