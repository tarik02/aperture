import { useMemo, useState } from "react";
import * as Effect from "effect/Effect";
import {
  SessionsApi,
  type ApiCredentials,
  type BrowserStatus,
  type IceServer,
} from "@aperture-browser/api-client";
import { useFork } from "./effect.tsx";
import {
  useBrowserControl,
  type SessionNotice,
  type UseBrowserControlResult,
} from "./hooks/use-browser-control.ts";

export interface ShareToken {
  readonly token: string;
  readonly sessionId: string;
  readonly role: "editor" | "viewer";
}

export function parseShareToken(token: string): ShareToken | null {
  const sessionId = token.slice(4, 40);
  const role = token.startsWith("ape_") ? "editor" : token.startsWith("apv_") ? "viewer" : null;
  if (!role || token[40] !== "_" || !sessionId || !token.slice(41)) {
    return null;
  }
  return { token, sessionId, role };
}

export type SharedSessionStatus = "invalid" | "loading" | "expired" | "unavailable" | "ready";

export interface UseSharedSessionOptions {
  readonly token: string;
  readonly displayName?: string | null;
  readonly onNotice?: (notice: SessionNotice) => void;
}

export interface UseSharedSessionResult {
  readonly status: SharedSessionStatus;
  readonly share: ShareToken | null;
  readonly browser: BrowserStatus | null;
  readonly control: UseBrowserControlResult;
}

type StatusState =
  | { readonly kind: "loading" | "expired" | "unavailable" }
  | { readonly kind: "ready"; readonly browser: BrowserStatus };

const emptyIceServers: readonly IceServer[] = [];

export function useSharedSession({
  token,
  displayName,
  onNotice,
}: UseSharedSessionOptions): UseSharedSessionResult {
  const share = useMemo(() => parseShareToken(token), [token]);
  const credentials = useMemo<ApiCredentials | null>(
    () =>
      share && {
        kind: "bearer",
        token: share.token,
        authorityType: null,
        tenantId: null,
        selectedTenantId: null,
      },
    [share],
  );
  const [state, setState] = useState<StatusState>({ kind: "loading" });

  useFork(
    () =>
      share && credentials
        ? Effect.sync(() => setState({ kind: "loading" })).pipe(
            Effect.andThen(
              SessionsApi.use((sessions) =>
                sessions.getBrowserStatus(credentials, share.sessionId),
              ),
            ),
            Effect.match({
              onFailure: (error) =>
                setState({ kind: error.status === 410 ? "expired" : "unavailable" }),
              onSuccess: (browser) =>
                setState(
                  browser.sessionId === share.sessionId
                    ? { kind: "ready", browser }
                    : { kind: "unavailable" },
                ),
            }),
          )
        : undefined,
    [credentials, share],
  );

  const browser = state.kind === "ready" ? state.browser : null;
  const control = useBrowserControl({
    sessionId: share?.sessionId ?? null,
    credentials: browser ? credentials : null,
    displayName,
    sessionToken: share?.token,
    collaborationRole: share?.role ?? "viewer",
    enabled: browser !== null,
    webrtcProducerSupported: browser?.media.mode === "auto" && browser.media.webrtcProducer,
    webrtcIceServers: browser?.media.iceServers ?? emptyIceServers,
    onNotice,
  });

  return {
    status: share ? state.kind : "invalid",
    share,
    browser,
    control,
  };
}
