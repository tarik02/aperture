import { format, formatDistanceToNow } from "date-fns";
import {
  ChevronRight,
  Copy,
  Download,
  File,
  FileArchive,
  FileImage,
  FileMusic,
  FileText,
  FileVideoCamera,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type { Session, SessionFileTreeNode } from "@aperture-browser/api-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { Input } from "@aperture-browser/ui/components/input";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { cn } from "@aperture-browser/ui/utils";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import {
  useCreateSessionDirectoryMutation,
  useDeleteSessionFileMutation,
  useDownloadSessionFile,
  useMoveSessionFileMutation,
  useSessionFilesQuery,
  useUploadSessionFileMutation,
} from "./session-files.queries.ts";
import {
  directoryChildren,
  errorMessage,
  fileKind,
  formatBytes,
  isRootDirectory,
  joinPath,
  nearestExistingDirectory,
  parentPath,
  pathCrumbs,
  validateEntryName,
} from "./session-files.utils.ts";

type PendingUpload = {
  id: string;
  name: string;
  /** The folder the upload was started from, where its pending row shows. */
  shownIn: string;
};

const kindIcons = {
  video: FileVideoCamera,
  image: FileImage,
  audio: FileMusic,
  archive: FileArchive,
  text: FileText,
  file: File,
} as const;

const rowClassName =
  "aperture:group/row aperture:flex aperture:h-8 aperture:min-w-0 aperture:items-center aperture:gap-2 aperture:rounded-md aperture:px-1.5 aperture:text-sm";

/**
 * The files of one session: downloads, recordings, uploads and tool output. Browses folders,
 * downloads, renames, deletes, creates folders and uploads files picked or dropped onto it.
 * Fills its parent; the caller provides the container.
 */
export function SessionFilesPanel({ session }: { session: Session }) {
  const sessionId = session.id;
  const query = useSessionFilesQuery(sessionId);
  const upload = useUploadSessionFileMutation(sessionId);
  const createDirectory = useCreateSessionDirectoryMutation(sessionId);
  const move = useMoveSessionFileMutation(sessionId);
  const remove = useDeleteSessionFileMutation(sessionId);
  const download = useDownloadSessionFile(sessionId);

  const [directory, setDirectory] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SessionFileTreeNode | null>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadSequence = useRef(0);

  // Reset to the root when the panel moves to another session.
  const [shownSession, setShownSession] = useState(sessionId);
  if (shownSession !== sessionId) {
    setShownSession(sessionId);
    setDirectory("");
    setCreatingFolder(false);
    setRenaming(null);
  }

  const entries = query.data;
  const children = useMemo(
    () => (entries ? directoryChildren(entries, directory) : null),
    [entries, directory],
  );

  // A folder deleted or moved elsewhere sends the panel to its nearest remaining ancestor.
  useEffect(() => {
    if (entries && children === null) {
      setDirectory(nearestExistingDirectory(entries, directory));
    }
  }, [entries, children, directory]);

  function navigate(next: string) {
    setDirectory(next);
    setCreatingFolder(false);
    setRenaming(null);
  }

  async function uploadFiles(files: ReadonlyArray<globalThis.File>) {
    if (files.length === 0) return;
    const shownIn = directory;
    // Root uploads go to the server's default `uploads` folder.
    const target = directory === "" ? undefined : directory;
    const batch = files.map((file) => ({
      id: `upload-${uploadSequence.current++}`,
      name: file.name,
      shownIn,
      file,
    }));
    setPending((current) => [
      ...current,
      ...batch.map((item) => ({ id: item.id, name: item.name, shownIn: item.shownIn })),
    ]);
    const results = await Promise.allSettled(
      batch.map(async (item) => {
        try {
          return await upload.mutateAsync({ file: item.file, directory: target });
        } finally {
          setPending((current) => current.filter((entry) => entry.id !== item.id));
        }
      }),
    );
    const failures = results.filter((result) => result.status === "rejected");
    const succeeded = results.length - failures.length;
    const where = target ?? "uploads";
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

  function hasFiles(event: DragEvent) {
    return event.dataTransfer.types.includes("Files");
  }

  function onDragEnter(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragOver(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(event: DragEvent) {
    if (!hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void uploadFiles(Array.from(event.dataTransfer.files));
  }

  async function submitNewFolder(name: string) {
    const relativePath = joinPath(directory, name.trim());
    try {
      await createDirectory.mutateAsync(relativePath);
      setCreatingFolder(false);
    } catch (error) {
      toast.error("Could not create folder", { description: errorMessage(error) });
    }
  }

  async function submitRename(node: SessionFileTreeNode, name: string) {
    const trimmed = name.trim();
    if (trimmed === node.name) {
      setRenaming(null);
      return;
    }
    try {
      await move.mutateAsync({
        from: node.relativePath,
        to: joinPath(parentPath(node.relativePath), trimmed),
      });
      setRenaming(null);
    } catch (error) {
      toast.error(`Could not rename ${node.name}`, { description: errorMessage(error) });
    }
  }

  async function startDownload(relativePath: string, name: string) {
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

  const pendingHere = pending.filter((item) => item.shownIn === directory);
  const empty = children !== null && children.length === 0 && pendingHere.length === 0;

  return (
    <div
      className="aperture:relative aperture:flex aperture:h-full aperture:min-h-0 aperture:flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="aperture:flex aperture:h-9 aperture:shrink-0 aperture:items-center aperture:gap-1 aperture:border-b aperture:pr-1.5 aperture:pl-3">
        <span className="aperture:min-w-0 aperture:flex-1 aperture:truncate aperture:text-sm aperture:font-medium">
          Files
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Upload files"
          title="Upload files"
          onClick={() => fileInput.current?.click()}
        >
          <Upload />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New folder"
          title="New folder"
          onClick={() => {
            setRenaming(null);
            setCreatingFolder(true);
          }}
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
            void uploadFiles(files);
          }}
        />
      </div>

      {directory === "" ? null : <Breadcrumbs directory={directory} onNavigate={navigate} />}

      <ScrollArea className="aperture:min-h-0 aperture:flex-1">
        <div className="aperture:@container aperture:grid aperture:gap-px aperture:px-1.5 aperture:pb-2">
          {creatingFolder ? (
            <NameInputRow
              icon={<Folder className="aperture:size-4 aperture:text-muted-foreground" />}
              initialValue=""
              placeholder="Folder name"
              pending={createDirectory.isPending}
              onSubmit={(name) => void submitNewFolder(name)}
              onCancel={() => setCreatingFolder(false)}
            />
          ) : null}
          {pendingHere.map((item) => (
            <div key={item.id} className={cn(rowClassName, "aperture:text-muted-foreground")}>
              <Spinner className="aperture:size-4 aperture:shrink-0" />
              <span className="aperture:min-w-0 aperture:flex-1 aperture:truncate">
                {item.name}
              </span>
              <span className="aperture:shrink-0 aperture:text-xs">Uploading</span>
            </div>
          ))}
          {children?.map((node) =>
            renaming === node.relativePath ? (
              <NameInputRow
                key={node.relativePath}
                icon={<EntryIcon node={node} />}
                initialValue={node.name}
                placeholder="Name"
                pending={move.isPending}
                onSubmit={(name) => void submitRename(node, name)}
                onCancel={() => setRenaming(null)}
              />
            ) : (
              <EntryRow
                key={node.relativePath}
                node={node}
                onOpen={() =>
                  node.kind === "directory"
                    ? navigate(node.relativePath)
                    : void startDownload(node.relativePath, node.name)
                }
                onDownload={() => void startDownload(node.relativePath, node.name)}
                onCopyPath={() => void copyPath(node.relativePath)}
                onRename={() => {
                  setCreatingFolder(false);
                  setRenaming(node.relativePath);
                }}
                onDelete={() => setDeleting(node)}
              />
            ),
          )}
          {query.isPending && !query.isError ? (
            <div className="aperture:flex aperture:justify-center aperture:py-6 aperture:text-muted-foreground">
              <Spinner className="aperture:size-4" />
            </div>
          ) : null}
          {query.isError ? (
            <p className="aperture:px-1.5 aperture:py-4 aperture:text-center aperture:text-xs aperture:text-muted-foreground">
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
          {empty && !query.isError ? (
            <div className="aperture:grid aperture:gap-1 aperture:px-4 aperture:py-8 aperture:text-center aperture:text-sm aperture:text-muted-foreground">
              <p>
                {directory === ""
                  ? "No files yet. Downloads, recordings and uploads appear here."
                  : "This folder is empty."}
              </p>
              <p className="aperture:text-xs aperture:text-muted-foreground/70">
                Drop files to upload
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>

      {dragging ? (
        <div className="aperture:pointer-events-none aperture:absolute aperture:inset-1.5 aperture:z-10 aperture:flex aperture:flex-col aperture:items-center aperture:justify-center aperture:gap-2 aperture:rounded-lg aperture:border-2 aperture:border-dashed aperture:border-primary/60 aperture:bg-background/85 aperture:text-sm aperture:text-muted-foreground">
          <Upload className="aperture:size-5" />
          <span>
            Drop to upload to{" "}
            <span className="aperture:font-medium aperture:text-foreground">
              {directory === "" ? "uploads" : directory}
            </span>
          </span>
        </div>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={deleting?.kind === "directory" ? "Delete folder?" : "Delete file?"}
        description={
          deleting?.kind === "directory"
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
              recursive: deleting.kind === "directory",
            });
          } catch (error) {
            toast.error(`Could not delete ${deleting.name}`, {
              description: errorMessage(error),
            });
            throw error;
          }
        }}
      />
    </div>
  );
}

function Breadcrumbs({
  directory,
  onNavigate,
}: {
  directory: string;
  onNavigate: (directory: string) => void;
}) {
  const crumbs = pathCrumbs(directory);
  const crumbClassName =
    "aperture:min-w-0 aperture:truncate aperture:rounded aperture:px-1 aperture:py-0.5 aperture:outline-none aperture:hover:bg-muted aperture:hover:text-foreground aperture:focus-visible:ring-2 aperture:focus-visible:ring-ring/50";

  return (
    <nav
      aria-label="Folder path"
      className="aperture:flex aperture:h-8 aperture:shrink-0 aperture:items-center aperture:gap-0.5 aperture:overflow-hidden aperture:px-2 aperture:text-xs aperture:text-muted-foreground"
    >
      <button
        type="button"
        className={cn(
          crumbClassName,
          "aperture:shrink-0",
          crumbs.length === 0 && "aperture:text-foreground",
        )}
        aria-current={crumbs.length === 0 ? "location" : undefined}
        onClick={() => onNavigate("")}
      >
        Files
      </button>
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        return (
          <Fragment key={crumb.path}>
            <ChevronRight className="aperture:size-3 aperture:shrink-0" aria-hidden />
            <button
              type="button"
              title={crumb.path}
              className={cn(
                crumbClassName,
                last && "aperture:font-medium aperture:text-foreground",
              )}
              aria-current={last ? "location" : undefined}
              onClick={() => onNavigate(crumb.path)}
            >
              {crumb.name}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}

function EntryIcon({ node }: { node: SessionFileTreeNode }) {
  const Icon = node.kind === "directory" ? Folder : kindIcons[fileKind(node.name)];
  return (
    <Icon
      className={cn(
        "aperture:size-4 aperture:shrink-0",
        node.kind === "directory" ? "aperture:text-primary/80" : "aperture:text-muted-foreground",
      )}
      aria-hidden
    />
  );
}

function EntryRow({
  node,
  onOpen,
  onDownload,
  onCopyPath,
  onRename,
  onDelete,
}: {
  node: SessionFileTreeNode;
  onOpen: () => void;
  onDownload: () => void;
  onCopyPath: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const modifiedAt =
    node.kind === "file" ? node.file.modifiedAt : (node.directory?.modifiedAt ?? null);
  const modified = modifiedAt === null ? null : new Date(modifiedAt);
  const fixed = node.kind === "directory" && isRootDirectory(node.relativePath);

  return (
    <div className={cn(rowClassName, "aperture:pr-0.5 aperture:hover:bg-muted/60")}>
      <button
        type="button"
        className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:gap-2 aperture:self-stretch aperture:text-left aperture:outline-none aperture:focus-visible:underline"
        title={node.kind === "directory" ? `Open ${node.name}` : `Download ${node.name}`}
        onClick={onOpen}
      >
        <EntryIcon node={node} />
        <span className="aperture:min-w-0 aperture:flex-1 aperture:truncate">{node.name}</span>
        <span className="aperture:flex aperture:shrink-0 aperture:items-center aperture:gap-1.5 aperture:text-xs aperture:text-muted-foreground aperture:tabular-nums">
          {node.kind === "file" ? <span>{formatBytes(node.file.size)}</span> : null}
          {modified ? (
            <span
              className="aperture:hidden aperture:@[16rem]:inline"
              title={format(modified, "yyyy-MM-dd HH:mm:ss")}
            >
              {formatDistanceToNow(modified, { addSuffix: true })}
            </span>
          ) : null}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Actions for ${node.name}`}
              className="aperture:shrink-0 aperture:opacity-0 aperture:group-hover/row:opacity-100 aperture:focus-visible:opacity-100 aperture:data-popup-open:opacity-100"
            >
              <MoreHorizontal />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="aperture:min-w-40">
          {node.kind === "file" ? (
            <DropdownMenuItem onClick={onDownload}>
              <Download />
              Download
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={onCopyPath}>
            <Copy />
            Copy path
          </DropdownMenuItem>
          {fixed ? null : (
            <>
              <DropdownMenuItem onClick={onRename}>
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function NameInputRow({
  icon,
  initialValue,
  placeholder,
  pending,
  onSubmit,
  onCancel,
}: {
  icon: ReactNode;
  initialValue: string;
  placeholder: string;
  pending: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const error = value === initialValue && initialValue === "" ? null : validateEntryName(value);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus();
    // Select the name without its extension, as file managers do.
    const dot = initialValue.lastIndexOf(".");
    element.setSelectionRange(0, dot > 0 ? dot : initialValue.length);
  }, [initialValue]);

  // Set between submitting and the request settling, so the blur that follows Enter does
  // not submit a second time.
  const submitting = useRef(false);
  useEffect(() => {
    if (!pending) submitting.current = false;
  }, [pending]);

  function submit() {
    if (pending || submitting.current) return;
    submitting.current = true;
    onSubmit(value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (validateEntryName(value) === null) submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  }

  return (
    <div className="aperture:grid aperture:gap-0.5 aperture:py-0.5">
      <div className={cn(rowClassName, "aperture:bg-muted/60")}>
        {pending ? <Spinner className="aperture:size-4 aperture:shrink-0" /> : icon}
        <Input
          ref={input}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          disabled={pending}
          className="aperture:h-6 aperture:min-w-0 aperture:flex-1 aperture:px-1.5 aperture:text-sm"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (pending || submitting.current) return;
            // Leaving the field keeps a changed, valid name and drops anything else.
            if (value.trim() !== initialValue && validateEntryName(value) === null) {
              submit();
            } else {
              onCancel();
            }
          }}
        />
      </div>
      {error ? (
        <p id={errorId} className="aperture:px-8 aperture:text-xs aperture:text-muted-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
