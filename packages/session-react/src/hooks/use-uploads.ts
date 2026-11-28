import { useCallback, useEffect, useRef, useState } from "react";
import type { Uploaded } from "@aperture-browser/session-client";
import { useSession, useSessionSnapshot } from "../session.tsx";

/** A file on its way into the session. */
export interface UploadInProgress {
  readonly name: string;
  readonly loaded: number;
  readonly total: number;
  /** Bytes a second lately, once there was time enough to tell. */
  readonly rate: number | undefined;
}

/** How long between the measures of a rate: shorter ones swing with each piece sent. */
const RATE_EVERY_MS = 1000;

export interface UploadsControl {
  /** The files that are in the session for its browser to take. */
  readonly uploads: readonly Uploaded[];
  readonly inProgress: readonly UploadInProgress[];
  readonly refresh: () => void;
  /**
   * Puts files into the session. Gives those that got there; `onFailure` hears of each
   * that did not.
   */
  readonly upload: (
    files: readonly File[],
    onFailure?: (file: File, cause: unknown) => void,
  ) => Promise<Uploaded[]>;
  /** Rejects with what the session answered. */
  readonly remove: (name: string) => Promise<void>;
  /** Gives up a file on its way, and what came of it. */
  readonly cancel: (name: string) => void;
}

/** The session's uploads. A file put there by another member shows at the next `refresh`. */
export function useUploads(enabled = true): UploadsControl {
  const session = useSession();
  const open = useSessionSnapshot().connection.state === "open" && enabled;
  const [uploads, setUploads] = useState<readonly Uploaded[]>([]);
  const [inProgress, setInProgress] = useState<readonly UploadInProgress[]>([]);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    let ended = false;
    session.uploads().then(
      (listed) => {
        if (!ended) {
          setUploads(listed.toSorted((a, b) => a.name.localeCompare(b.name)));
        }
      },
      () => {
        // The list stays as it was until it is asked for again.
      },
    );
    return () => {
      ended = true;
    };
  }, [session, open, asked]);

  const refresh = useCallback(() => setAsked((current) => current + 1), []);
  const sending = useRef(new Map<string, AbortController>());

  const upload = useCallback(
    async (files: readonly File[], onFailure?: (file: File, cause: unknown) => void) => {
      const put = await Promise.all(
        files.map(async (file) => {
          let measured = { at: performance.now(), loaded: 0 };
          let rate: number | undefined;
          const progress = (loaded: number, total: number) => {
            const at = performance.now();
            const elapsed = at - measured.at;
            if (elapsed >= RATE_EVERY_MS) {
              const lately = ((loaded - measured.loaded) * 1000) / elapsed;
              // What came back at once after a resume is no speed of the link.
              if (lately >= 0) {
                rate = rate === undefined ? lately : rate * 0.7 + lately * 0.3;
              }
              measured = { at, loaded };
            }
            setInProgress((current) => [
              ...current.filter((one) => one.name !== file.name),
              { name: file.name, loaded, total, rate },
            ]);
          };
          progress(0, file.size);
          // A file of the name that is on its way already is put in its place.
          sending.current.get(file.name)?.abort();
          const aborted = new AbortController();
          sending.current.set(file.name, aborted);
          try {
            return await session.upload(
              file,
              ({ loaded, total }) => progress(loaded, total),
              aborted.signal,
            );
          } catch (cause) {
            if (!aborted.signal.aborted) {
              onFailure?.(file, cause);
            }
            return undefined;
          } finally {
            if (sending.current.get(file.name) === aborted) {
              sending.current.delete(file.name);
              setInProgress((current) => current.filter((one) => one.name !== file.name));
            }
          }
        }),
      );
      refresh();
      return put.filter((one) => one !== undefined);
    },
    [session, refresh],
  );

  const remove = useCallback(
    async (name: string) => {
      try {
        await session.removeUpload(name);
      } finally {
        refresh();
      }
    },
    [session, refresh],
  );

  const cancel = useCallback((name: string) => sending.current.get(name)?.abort(), []);

  return { uploads, inProgress, refresh, upload, remove, cancel };
}
