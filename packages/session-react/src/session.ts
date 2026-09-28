import { useState } from "react";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { BrowserStatus, IceServer } from "@aperture-browser/api-client";
import { getSessionStatus, type SessionAccess } from "@aperture-browser/live-session";
import { useFork } from "./effect.tsx";
import {
  useBrowserControl,
  type SessionNotice,
  type UseBrowserControlResult,
} from "./hooks/use-browser-control.ts";

/** Convert an editor/viewer share link into direct session access. */
export function shareSessionAccess(token: string, baseUrl?: string): SessionAccess | null {
  const sessionId = token.slice(4, 40);
  if (
    (!token.startsWith("ape_") && !token.startsWith("apv_")) ||
    token[40] !== "_" ||
    token.slice(41).length === 0
  ) {
    return null;
  }
  return {
    kind: "direct",
    baseUrl,
    sessionId,
    credentials: {
      kind: "bearer",
      token: Redacted.make(token),
      authorityType: null,
      tenantId: null,
      selectedTenantId: null,
    },
  };
}

export type SessionStatus = "invalid" | "loading" | "denied" | "expired" | "unavailable" | "ready";

interface SessionState {
  readonly access: SessionAccess | null;
  readonly status: Exclude<SessionStatus, "invalid">;
  readonly browser: BrowserStatus | null;
}

const emptyIceServers: readonly IceServer[] = [];

export interface UseSessionOptions {
  readonly access: SessionAccess | null;
  readonly displayName?: string | null;
  readonly onNotice?: (notice: SessionNotice) => void;
}

export interface UseSessionResult {
  readonly status: SessionStatus;
  readonly browser: BrowserStatus | null;
  readonly control: UseBrowserControlResult;
}

export function useSession({ access, displayName, onNotice }: UseSessionOptions): UseSessionResult {
  const [state, setState] = useState<SessionState>({
    access: null,
    status: "loading",
    browser: null,
  });
  useFork(() => {
    if (access === null) {
      return undefined;
    }
    setState({ access, status: "loading", browser: null });
    return getSessionStatus(access).pipe(
      Effect.match({
        onFailure: (error) =>
          setState({
            access,
            status:
              error.status === 401 || error.status === 403
                ? "denied"
                : error.status === 410
                  ? "expired"
                  : "unavailable",
            browser: null,
          }),
        onSuccess: (browser) =>
          setState(
            access.kind === "direct" && browser.sessionId !== access.sessionId
              ? { access, status: "unavailable", browser: null }
              : { access, status: "ready", browser },
          ),
      }),
    );
  }, [access]);
  const browser = state.access === access ? state.browser : null;
  const control = useBrowserControl({
    access: browser === null ? null : access,
    displayName,
    webrtcProducerSupported: browser?.media.mode === "auto" && browser.media.webrtcProducer,
    webrtcIceServers: browser?.media.iceServers ?? emptyIceServers,
    onNotice,
  });
  const status: SessionStatus =
    access === null ? "invalid" : state.access !== access ? "loading" : state.status;
  return { status, browser, control };
}
