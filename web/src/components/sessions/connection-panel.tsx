import { Link } from "@tanstack/react-router";
import { AppWindow, Cable, ChevronDown, KeyRound } from "lucide-react";
import { CopyField } from "#/components/resources/copy-field.tsx";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";
import { DialogFooter } from "#/components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import type { Session } from "#/lib/api/schemas.ts";
import { useRotateSessionTokenMutation } from "#/features/session/session.mutations.ts";
import { useSessionQuery } from "#/features/session/session.queries.ts";
import { useEffect, useMemo, useState } from "react";

type ConnectionPanelProps = {
  session: Session;
  onRotate?: (session: Session) => void;
  modalFooter?: boolean;
};

export function ConnectionPanel({ session, onRotate, modalFooter }: ConnectionPanelProps) {
  const rotateMutation = useRotateSessionTokenMutation();
  const sessionQuery = useSessionQuery(session.id);
  const [publicOrigin, setPublicOrigin] = useState<string | null>(null);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [rotatedSession, setRotatedSession] = useState<Session | null>(null);

  const detailedSession = sessionQuery.data ?? session;
  const rotatedCredentials = rotatedSession?.id === detailedSession.id ? rotatedSession : null;
  const currentSession = rotatedCredentials ?? detailedSession;
  const rawCdpUrl = currentSession.connection.cdpUrl;
  const sessionToken = currentSession.connection.sessionToken;
  const viewerToken = currentSession.collaboration?.viewerToken;
  const cdpUrl = useMemo(
    () => (rawCdpUrl ? publicCdpUrl(rawCdpUrl, publicOrigin) : null),
    [publicOrigin, rawCdpUrl],
  );
  const tokenizedCdpUrl = useMemo(
    () => (cdpUrl && sessionToken ? cdpUrlWithToken(cdpUrl, sessionToken) : null),
    [cdpUrl, sessionToken],
  );
  const shareLink = useMemo(() => {
    if (!publicOrigin || !viewerToken) {
      return null;
    }
    const url = new URL("/share/", publicOrigin);
    url.hash = new URLSearchParams({ token: viewerToken }).toString();
    return url.toString();
  }, [publicOrigin, viewerToken]);
  const canOpen = currentSession.status === "running" || currentSession.status === "suspended";

  useEffect(() => {
    setPublicOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    setRotatedSession(null);
  }, [session.id]);

  async function handleRotate() {
    const result = await rotateMutation.mutateAsync(session.id);
    setRotatedSession(result.session);
    onRotate?.(result.session);
  }

  const fields = (
    <div className="flex flex-col gap-3">
      {cdpUrl ? <CopyField value={cdpUrl} label="CDP URL" /> : null}
      {sessionToken ? <CopyField value={sessionToken} label="Token" /> : null}
      {tokenizedCdpUrl ? <CopyField value={tokenizedCdpUrl} label="CDP URL with token" /> : null}
      {shareLink ? <CopyField value={shareLink} label="Share link" /> : null}
    </div>
  );

  const actions = (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="whitespace-nowrap"
        onClick={() => setRotateConfirmOpen(true)}
        disabled={
          rotateMutation.isPending ||
          (currentSession.status !== "running" && currentSession.status !== "suspended")
        }
      >
        <KeyRound data-icon="inline-start" />
        Rotate session token
      </Button>
      <OpenSessionButton sessionId={session.id} disabled={!canOpen} />
    </>
  );

  return (
    <div className={modalFooter ? "flex h-full min-h-0 flex-col" : "flex flex-col gap-3"}>
      {modalFooter ? (
        <>
          <ScrollArea className="min-h-0 flex-1" viewportClassName="pr-3">
            {fields}
          </ScrollArea>
          <DialogFooter className="mt-4 shrink-0">{actions}</DialogFooter>
        </>
      ) : (
        <>
          {fields}
          <Separator />
          <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
        </>
      )}
      <ConfirmDialog
        open={rotateConfirmOpen}
        title="Rotate Session token"
        description="The current Session token for this session will stop working."
        confirmLabel="Rotate"
        pending={rotateMutation.isPending}
        onOpenChange={setRotateConfirmOpen}
        onConfirm={handleRotate}
      />
    </div>
  );
}

type OpenSessionButtonProps = {
  sessionId: string;
  disabled: boolean;
};

function OpenSessionButton({ sessionId, disabled }: OpenSessionButtonProps) {
  return (
    <div className="flex w-fit">
      <Button
        type="button"
        size="sm"
        className="rounded-r-none"
        disabled={disabled}
        render={disabled ? undefined : <Link to="/-/sessions/$sessionId" params={{ sessionId }} />}
        nativeButton={disabled}
      >
        <AppWindow data-icon="inline-start" />
        Open
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              className="-ml-px rounded-l-none border-l-primary-foreground/30"
              aria-label="Open session options"
              disabled={disabled}
            />
          }
        >
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuGroup>
            <DropdownMenuItem
              render={
                <Link
                  to="/-/sessions/$sessionId"
                  params={{ sessionId }}
                  search={{ media: "cdp" }}
                />
              }
            >
              <Cable />
              CDP fallback
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function publicCdpUrl(rawCdpUrl: string, publicOrigin: string | null) {
  if (!publicOrigin) {
    return rawCdpUrl;
  }

  try {
    const sourceUrl = new URL(rawCdpUrl, publicOrigin);
    const publicUrl = new URL(publicOrigin);
    publicUrl.pathname = sourceUrl.pathname;
    publicUrl.search = sourceUrl.search;
    publicUrl.hash = sourceUrl.hash;
    return publicUrl.toString();
  } catch {
    return rawCdpUrl;
  }
}

function cdpUrlWithToken(cdpUrl: string, sessionToken: string) {
  const url = new URL(cdpUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(sessionToken)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
