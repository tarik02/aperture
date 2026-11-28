import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CircleAlert,
  FileIcon,
  FolderOpen,
  Loader2,
  Trash2,
  X,
} from "lucide-react";
import type { Download, FileRequest, Uploaded } from "@aperture-browser/session-client";
import { Button } from "@aperture-browser/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@aperture-browser/ui/components/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { cn } from "@aperture-browser/ui/utils";
import { useUploads, type UploadsControl } from "../hooks/use-uploads.ts";
import { useWorkbench } from "../workbench/context.tsx";
import { failureText, showNotice } from "../notices.ts";
import { useSession, useSessionSnapshot } from "../session.tsx";
import { formatBytes } from "./menu-parts.tsx";

/**
 * The session's files, from a button of the toolbar: what was uploaded for its browser to
 * take, what it downloaded, and the files a page of the watched tab asks for. The panel
 * opens by itself when a page asks and when a download is done.
 */
export function SessionFilesButton() {
  const { features } = useWorkbench();
  const { open, setOpen, request, busy, label, panel } = useSessionFiles();

  if (!features.files) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label}
                  data-session-files-button=""
                  className="aperture:relative"
                />
              }
            />
          }
        >
          <FolderOpen />
          {request !== undefined ? (
            <span className="aperture:absolute aperture:top-0.5 aperture:right-0.5 aperture:size-2 aperture:animate-pulse aperture:rounded-full aperture:bg-amber-500 aperture:ring-2 aperture:ring-background" />
          ) : null}
          {request === undefined && busy > 0 ? (
            <span className="aperture:absolute aperture:-top-0.5 aperture:-right-0.5 aperture:flex aperture:h-3.5 aperture:min-w-3.5 aperture:items-center aperture:justify-center aperture:rounded-full aperture:bg-primary aperture:px-0.5 aperture:text-[0.5625rem] aperture:leading-none aperture:font-medium aperture:text-primary-foreground">
              {busy}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        className="aperture:w-88 aperture:max-w-[calc(100vw-1rem)] aperture:gap-0 aperture:p-0"
        aria-label="Files"
        data-session-files=""
      >
        {panel}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The session's files as a panel that is opened from somewhere: whether it is open, which
 * it is by itself when a page asks for a file and when a download is done, and what tells
 * of it where it is opened from. In a `sheet` the panel is as long as what it holds, and
 * the sheet is what scrolls.
 */
export function useSessionFiles({ sheet = false }: { sheet?: boolean } = {}) {
  const snapshot = useSessionSnapshot();
  const { features } = useWorkbench();
  const uploads = useUploads(features.uploads);
  const [open, setOpen] = useState(false);
  const request = snapshot.fileRequests.find((one) => one.tab === snapshot.selected);
  const running = snapshot.downloads.filter((download) => download.state === "running").length;
  const done = snapshot.downloads.filter((download) => download.state === "done").length;
  const busy = running + uploads.inProgress.length;

  const { refresh } = uploads;
  const seen = useRef({ request: request?.id, done });
  useEffect(() => {
    const asked = request !== undefined && request.id !== seen.current.request;
    const finished = done > seen.current.done;
    seen.current = { request: request?.id, done };
    if (asked || finished) {
      setOpen(true);
    }
  }, [request, done]);

  // Another member may have uploaded since the panel was last open.
  useEffect(() => {
    if (open) {
      refresh();
    }
  }, [open, refresh]);

  return {
    open,
    setOpen,
    request,
    busy,
    label: request === undefined ? "Files" : "Files: a page asks for one",
    panel: (
      <SessionFiles
        uploads={uploads}
        request={request}
        downloads={snapshot.downloads}
        offers={features}
        puts={features.access.uploads.write}
        sheet={sheet}
      />
    ),
  };
}

function SessionFiles({
  uploads,
  request,
  downloads,
  offers,
  puts,
  sheet,
}: {
  uploads: UploadsControl;
  request: FileRequest | undefined;
  downloads: readonly Download[];
  /** Which of the two the session has. */
  offers: { readonly uploads: boolean; readonly downloads: boolean };
  /** This member may put files into the session, and answer pages with them. */
  puts: boolean;
  sheet: boolean;
}) {
  const session = useSession();
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [chosen, setChosen] = useState<readonly string[]>([]);

  // A choice made for one request is not one for the next.
  const requestId = request?.id;
  useEffect(() => setChosen([]), [requestId]);

  const failed = (file: File, cause: unknown) =>
    showNotice({
      level: "error",
      message: `${file.name} was not uploaded`,
      description: failureText(cause),
    });

  const put = async (files: readonly File[], answers: FileRequest | undefined) => {
    const uploaded = await uploads.upload(files, failed);
    // Files picked while a page asks are the answer, as they are in a browser of one's own.
    if (answers !== undefined && uploaded.length > 0) {
      const names = uploaded.map((file) => file.name);
      session.chooseFiles(answers.id, answers.multiple ? names : names.slice(0, 1));
    }
  };

  const toggle = (name: string) => {
    if (request === undefined) {
      return;
    }
    if (!request.multiple) {
      setChosen(chosen.includes(name) ? [] : [name]);
      return;
    }
    setChosen(chosen.includes(name) ? chosen.filter((one) => one !== name) : [...chosen, name]);
  };

  const remove = (file: Uploaded) => {
    uploads.remove(file.name).catch((cause: unknown) => {
      showNotice({
        level: "error",
        message: `${file.name} was not removed`,
        description: failureText(cause),
      });
    });
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      void put(files, undefined);
    }
  };

  const existing = chosen.filter((name) => uploads.uploads.some((file) => file.name === name));
  const listed = downloads.toReversed();

  return (
    <div
      className={cn(
        "aperture:relative aperture:flex aperture:flex-col",
        sheet ? "aperture:min-h-full" : "aperture:max-h-[min(32rem,calc(100dvh-6rem))]",
      )}
      onDragOver={(event) => {
        if (offers.uploads && puts && event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragging(false);
        }
      }}
      onDrop={drop}
    >
      <input
        ref={picker}
        type="file"
        hidden
        multiple={request === undefined || request.multiple}
        data-session-file-input=""
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) {
            void put(files, request);
          }
        }}
      />
      {request === undefined ? null : (
        <div
          data-session-file-request=""
          className="aperture:flex aperture:flex-col aperture:gap-2 aperture:border-b aperture:border-amber-500/40 aperture:bg-amber-500/10 aperture:p-2.5"
        >
          <span className="aperture:text-sm aperture:font-medium">
            {request.multiple ? "The page asks for files" : "The page asks for a file"}
          </span>
          <div className="aperture:flex aperture:flex-wrap aperture:items-center aperture:gap-1.5">
            <Button
              type="button"
              size="sm"
              disabled={!puts}
              onClick={() => picker.current?.click()}
            >
              <ArrowUpFromLine />
              Upload…
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={existing.length === 0 || !puts}
              onClick={() => session.chooseFiles(request.id, existing)}
            >
              <Check />
              {giveLabel(request, existing.length)}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="aperture:ml-auto"
              disabled={!puts}
              onClick={() => session.chooseFiles(request.id, [])}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      <div className={cn("aperture:flex-1", !sheet && "aperture:min-h-0 aperture:overflow-y-auto")}>
        {offers.uploads ? (
          <section className="aperture:flex aperture:flex-col aperture:gap-1 aperture:p-2.5">
            <header className="aperture:flex aperture:h-6 aperture:items-center aperture:justify-between aperture:gap-2">
              <h3 className="aperture:text-xs aperture:text-muted-foreground">Uploads</h3>
              {request === undefined ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={!puts}
                  onClick={() => picker.current?.click()}
                >
                  <ArrowUpFromLine />
                  Upload
                </Button>
              ) : null}
            </header>
            {uploads.inProgress.map((file) => (
              <div
                key={file.name}
                data-session-upload-progress=""
                className="aperture:flex aperture:flex-col aperture:gap-1 aperture:rounded-md aperture:px-1.5 aperture:py-1"
              >
                <div className="aperture:flex aperture:items-center aperture:gap-2 aperture:text-sm">
                  <Loader2 className="aperture:size-4 aperture:shrink-0 aperture:animate-spin aperture:text-muted-foreground" />
                  <span className="aperture:min-w-0 aperture:flex-1 aperture:truncate">
                    {file.name}
                  </span>
                  <span className="aperture:shrink-0 aperture:text-xs aperture:text-muted-foreground aperture:tabular-nums">
                    {file.rate === undefined || file.rate <= 0
                      ? percent(file.loaded, file.total)
                      : `${speed(file.rate)} · ${left((file.total - file.loaded) / file.rate)} · ${percent(file.loaded, file.total)}`}
                  </span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Cancel the upload of ${file.name}`}
                    data-session-upload-cancel=""
                    className="aperture:shrink-0"
                    onClick={() => uploads.cancel(file.name)}
                  >
                    <X />
                  </Button>
                </div>
                <div className="aperture:h-1 aperture:overflow-hidden aperture:rounded-full aperture:bg-muted">
                  <div
                    className="aperture:h-full aperture:rounded-full aperture:bg-primary aperture:transition-[width]"
                    style={{ width: percent(file.loaded, file.total) }}
                  />
                </div>
              </div>
            ))}
            {uploads.uploads.map((file) => {
              const picked = chosen.includes(file.name);
              return (
                <div
                  key={file.name}
                  data-session-upload={file.name}
                  className={cn(
                    "aperture:group/file aperture:flex aperture:items-center aperture:gap-2 aperture:rounded-md aperture:px-1.5 aperture:py-1 aperture:text-sm",
                    request !== undefined && "aperture:cursor-default aperture:hover:bg-muted",
                    picked && "aperture:bg-accent aperture:text-accent-foreground",
                  )}
                  role={request === undefined ? undefined : "option"}
                  aria-selected={request === undefined ? undefined : picked}
                  onClick={() => toggle(file.name)}
                >
                  {picked ? (
                    <Check className="aperture:size-4 aperture:shrink-0" />
                  ) : (
                    <FileIcon className="aperture:size-4 aperture:shrink-0 aperture:text-muted-foreground" />
                  )}
                  <span
                    className="aperture:min-w-0 aperture:flex-1 aperture:truncate"
                    title={file.path}
                  >
                    {file.name}
                  </span>
                  <span className="aperture:shrink-0 aperture:text-xs aperture:text-muted-foreground aperture:tabular-nums">
                    {formatBytes(file.size)}
                  </span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${file.name}`}
                    className="aperture:shrink-0 aperture:opacity-55 aperture:group-hover/file:opacity-100 aperture:hover:opacity-100 aperture:pointer-coarse:opacity-100"
                    disabled={!puts}
                    onClick={(event) => {
                      event.stopPropagation();
                      remove(file);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              );
            })}
            {uploads.uploads.length === 0 && uploads.inProgress.length === 0 ? (
              <p
                title={puts ? "Drop files here, or onto the page itself" : undefined}
                className="aperture:rounded-md aperture:border aperture:border-dashed aperture:px-2 aperture:py-3 aperture:text-center aperture:text-xs aperture:text-muted-foreground"
              >
                Nothing uploaded
              </p>
            ) : null}
          </section>
        ) : null}
        {offers.downloads ? (
          <section className="aperture:flex aperture:flex-col aperture:gap-1 aperture:p-2.5 aperture:not-first:border-t">
            <header className="aperture:flex aperture:h-6 aperture:items-center">
              <span className="aperture:text-xs aperture:font-medium aperture:text-muted-foreground">
                Downloads
              </span>
            </header>
            {listed.map((download) => (
              <DownloadRow
                key={download.id}
                download={download}
                href={session.fileUrl(`downloads/${download.name}`)}
              />
            ))}
            {listed.length === 0 ? (
              <p className="aperture:px-1.5 aperture:py-1 aperture:text-xs aperture:text-muted-foreground">
                No downloads
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
      {dragging ? (
        <div className="aperture:pointer-events-none aperture:absolute aperture:inset-1 aperture:flex aperture:items-center aperture:justify-center aperture:rounded-md aperture:border-2 aperture:border-dashed aperture:border-primary/60 aperture:bg-background/90 aperture:text-sm aperture:font-medium">
          Drop to upload
        </div>
      ) : null}
    </div>
  );
}

function DownloadRow({ download, href }: { download: Download; href: string }) {
  const { state } = download;
  const received = formatBytes(download.receivedBytes);
  const progress =
    download.totalBytes === undefined || download.totalBytes === 0
      ? received
      : percent(download.receivedBytes, download.totalBytes);

  return (
    <div
      data-session-download={download.name}
      data-state={state}
      className="aperture:flex aperture:items-center aperture:gap-2 aperture:rounded-md aperture:px-1.5 aperture:py-1 aperture:text-sm"
      title={download.url}
    >
      {state === "done" ? (
        <ArrowDownToLine className="aperture:size-4 aperture:shrink-0 aperture:text-muted-foreground" />
      ) : null}
      {state === "failed" ? (
        <CircleAlert className="aperture:size-4 aperture:shrink-0 aperture:text-destructive" />
      ) : null}
      {state !== "done" && state !== "failed" ? (
        <Loader2 className="aperture:size-4 aperture:shrink-0 aperture:animate-spin aperture:text-muted-foreground" />
      ) : null}
      {state === "done" ? (
        <a
          href={href}
          download={download.name}
          className="aperture:min-w-0 aperture:flex-1 aperture:truncate aperture:underline aperture:decoration-muted-foreground/50 aperture:underline-offset-2 aperture:hover:decoration-foreground"
        >
          {download.name}
        </a>
      ) : (
        <span className="aperture:min-w-0 aperture:flex-1 aperture:truncate">{download.name}</span>
      )}
      <span
        className={cn(
          "aperture:shrink-0 aperture:text-xs aperture:text-muted-foreground aperture:tabular-nums",
          state === "failed" && "aperture:text-destructive",
        )}
      >
        {state === "done" ? received : null}
        {state === "failed" ? "Failed" : null}
        {state !== "done" && state !== "failed" ? progress : null}
      </span>
    </div>
  );
}

function giveLabel(request: FileRequest, chosen: number): string {
  if (chosen > 1) {
    return `Give ${chosen} files`;
  }
  return request.multiple && chosen === 0 ? "Give the files" : "Give the file";
}

function speed(bytesPerSecond: number): string {
  const [unit, size] =
    bytesPerSecond >= 1024 ** 3
      ? ["GB", 1024 ** 3]
      : bytesPerSecond >= 1024 ** 2
        ? ["MB", 1024 ** 2]
        : ["KB", 1024];
  return `${Number((bytesPerSecond / size).toFixed(1))} ${unit}/s`;
}

function left(seconds: number): string {
  const whole = Math.max(1, Math.ceil(seconds));
  if (whole < 60) {
    return `${whole} s left`;
  }
  const minutes = Math.ceil(whole / 60);
  return minutes < 60
    ? `${minutes} min left`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

function percent(loaded: number, total: number): string {
  return total <= 0 ? "0%" : `${Math.min(100, Math.round((100 * loaded) / total))}%`;
}
