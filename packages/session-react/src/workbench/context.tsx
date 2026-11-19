import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type { Recording, Session, Target } from "@aperture-browser/session-client";
import {
  resolveSessionFeatures,
  type ResolvedSessionFeatures,
  type SessionFeatures,
} from "../features.ts";
import { useRememberedFit } from "../hooks/use-fit.ts";
import {
  recordingIsEdited,
  recordingRuns,
  useRecordings,
  type RecordingsControl,
} from "../hooks/use-recordings.ts";
import { showNotice } from "../notices.ts";
import { useSession, useSessionSnapshot } from "../session.tsx";
import type { ApertureTheme } from "../ui-root.tsx";
import type { WorkbenchContribution } from "./contributions.ts";

/** The theme, where the embedding page lets the workbench's menu change it. */
export interface Appearance {
  readonly theme: ApertureTheme;
  readonly onThemeChange: (theme: ApertureTheme) => void;
}

export interface Workbench {
  readonly features: ResolvedSessionFeatures;
  readonly recordings: RecordingsControl;
  readonly contributions: readonly WorkbenchContribution[];
  /** The id of the recording or screenshot the gallery shows; none while it is closed. */
  readonly viewed: string | undefined;
  readonly view: (id: string | undefined) => void;
  readonly appearance: Appearance | undefined;
  readonly targetFaviconUrl: ((target: Target) => string | undefined) | undefined;
}

const WorkbenchContext = createContext<Workbench | null>(null);

export interface WorkbenchProviderProps {
  readonly features?: SessionFeatures | undefined;
  /** What the workbench's slots show; see `workbenchContributions` for its own. */
  readonly contributions: readonly WorkbenchContribution[];
  /**
   * Whether targets take the size of this window unless the person switched that off.
   * False leaves them the size they have until the person chooses another.
   */
  readonly fit?: boolean | undefined;
  /** Lets the browser menu change the theme. */
  readonly appearance?: Appearance | undefined;
  /**
   * A tab's icon. Without it tabs show none: the session does not tell a page's icon, and
   * asking the page's site for it would tell that site who watches.
   */
  readonly targetFaviconUrl?: ((target: Target) => string | undefined) | undefined;
  readonly children?: ReactNode;
}

/**
 * What the parts of a workbench share: the session's recordings, what is shown, and what
 * is contributed to the slots. The parts work anywhere below it, in any arrangement.
 */
export function WorkbenchProvider({
  features: given,
  contributions,
  fit = true,
  appearance,
  targetFaviconUrl,
  children,
}: WorkbenchProviderProps) {
  const offered = useSessionSnapshot().features;
  const features = useMemo(() => resolveSessionFeatures(given, offered), [given, offered]);
  const recordings = useRecordings(features.recordings);
  useClipboardNotices();
  useFailureNotices();
  useRecordingNotices(recordings);
  useRememberedFit(fit);

  const [viewed, view] = useState<string | undefined>(undefined);

  const value = useMemo(
    () => ({ features, recordings, contributions, viewed, view, appearance, targetFaviconUrl }),
    [features, recordings, contributions, viewed, appearance, targetFaviconUrl],
  );
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench(): Workbench {
  const value = useContext(WorkbenchContext);
  if (value === null) {
    throw new Error("The workbench's parts are used outside a WorkbenchProvider");
  }
  return value;
}

/**
 * What the session copied goes to this browser's clipboard by itself where the browser
 * lets a page write to it at any time. Where it does not, a notice offers the click that
 * the browser wants.
 */
function useClipboardNotices() {
  const session = useSession();

  useEffect(
    () =>
      session.onClipboard((event) => {
        if (event.written) {
          return;
        }
        const picture = !event.forms.some((form) => form.type === "text/plain");
        toast("The session copied something", {
          id: "aperture-session-copied",
          description: picture
            ? "This browser did not take it. Open the picture to copy it by hand."
            : "This browser did not take it without a click.",
          duration: 15_000,
          action: {
            label: picture ? "Open" : "Copy",
            onClick: () => copyByHand(session, event.forms),
          },
        });
      }),
    [session],
  );
}

const NOT_DONE = {
  go: "The page did not open",
  close: "The tab was not closed",
  copyPicture: "The picture was not copied",
  chooseFiles: "The page did not get the files",
} as const;

function useFailureNotices() {
  const session = useSession();

  useEffect(
    () =>
      session.onFailure((failure) => {
        showNotice({
          level: "error",
          message:
            failure.asked === undefined ? "The session did not do that" : NOT_DONE[failure.asked],
          description: failure.reason,
        });
      }),
    [session],
  );
}

function copyByHand(session: Session, forms: Parameters<Session["copyHere"]>[0]) {
  const refused = () =>
    showNotice({ level: "error", message: "This browser did not take the copy" });
  session.copyHere(forms).then((written) => {
    if (written) {
      showNotice({ level: "info", message: "Copied" });
    } else {
      refused();
    }
  }, refused);
}

/** Tells when a recording ends and when its edit is made, whoever started it. */
function useRecordingNotices({ recordings }: RecordingsControl) {
  const before = useRef<ReadonlyMap<string, Recording> | undefined>(undefined);

  useEffect(() => {
    const known = before.current;
    before.current = new Map(recordings.map((recording) => [recording.id, recording]));
    // The recordings there were when the page opened are no news.
    if (known === undefined) {
      return;
    }
    for (const recording of recordings) {
      const was = known.get(recording.id);
      if (was === undefined) {
        continue;
      }
      if (recordingRuns(was) && recording.state === "finished") {
        showNotice({
          level: "info",
          message: "Recording finished",
          description: recordingIsEdited(recording)
            ? "The raw recording is in the session's files. Its edit is being made."
            : "The raw recording is in the session's files.",
        });
      }
      if (recordingRuns(was) && recording.state === "failed") {
        showNotice({
          level: "error",
          message: "Recording failed",
          description: recording.failure ?? undefined,
        });
      }
      if (recordingIsEdited(was) && recording.edit?.state === "finished") {
        showNotice({
          level: "info",
          message: "Recording edit finished",
          description: "It is in the recording menu, next to the raw recording.",
        });
      }
      if (recordingIsEdited(was) && recording.edit?.state === "failed") {
        showNotice({
          level: "error",
          message: "Recording edit failed",
          description: recording.edit.failure ?? undefined,
        });
      }
    }
  }, [recordings]);
}
