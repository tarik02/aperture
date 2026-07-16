import { Link } from "@tanstack/react-router";
import { AppWindow, ChevronDown } from "lucide-react";
import { CopyField } from "#/components/resources/copy-field.tsx";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import type { Session } from "#/lib/api/schemas.ts";
import { useRotateCdpTokenMutation } from "#/features/session/session.mutations.ts";
import { useSessionQuery } from "#/features/session/session.queries.ts";
import { useEffect, useMemo, useState } from "react";

type ConnectionPanelProps = {
  session: Session;
  onRotate?: (session: Session) => void;
};

export function ConnectionPanel({ session, onRotate }: ConnectionPanelProps) {
  const rotateMutation = useRotateCdpTokenMutation();
  const sessionQuery = useSessionQuery(session.id);
  const [publicOrigin, setPublicOrigin] = useState<string | null>(null);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);
  const [rotatedSession, setRotatedSession] = useState<Session | null>(null);

  const detailedSession = sessionQuery.data ?? session;
  const rotatedCredentials = rotatedSession?.id === detailedSession.id ? rotatedSession : null;
  const currentSession = rotatedCredentials
    ? {
        ...detailedSession,
        cdpUrl: rotatedCredentials.cdpUrl,
        cdpToken: rotatedCredentials.cdpToken,
      }
    : detailedSession;
  const rawCdpUrl = currentSession.cdpUrl;
  const cdpUrl = useMemo(
    () => (rawCdpUrl ? publicCdpUrl(rawCdpUrl, publicOrigin) : null),
    [publicOrigin, rawCdpUrl],
  );
  const tokenizedCdpUrl = useMemo(
    () =>
      cdpUrl && currentSession.cdpToken ? cdpUrlWithToken(cdpUrl, currentSession.cdpToken) : null,
    [cdpUrl, currentSession.cdpToken],
  );
  const shareLink = useMemo(() => {
    if (!publicOrigin || !currentSession.cdpToken) {
      return null;
    }
    const url = new URL("/share/", publicOrigin);
    url.hash = new URLSearchParams({ token: currentSession.cdpToken }).toString();
    return url.toString();
  }, [currentSession.cdpToken, publicOrigin]);
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

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Connection</h3>
      {cdpUrl ? <CopyField value={cdpUrl} label="CDP URL" /> : null}
      {currentSession.cdpToken ? <CopyField value={currentSession.cdpToken} label="Token" /> : null}
      {tokenizedCdpUrl ? <CopyField value={tokenizedCdpUrl} label="CDP URL with token" /> : null}
      {shareLink ? <CopyField value={shareLink} label="Share link" /> : null}
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-2">
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
          Rotate CDP token
        </Button>
        <OpenSessionButton sessionId={session.id} disabled={!canOpen} />
      </div>
      <ConfirmDialog
        open={rotateConfirmOpen}
        title="Rotate CDP token"
        description="The current CDP token for this session will stop working."
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
              disabled={disabled}
            />
          }
        >
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem
            render={
              <Link to="/-/sessions/$sessionId" params={{ sessionId }} search={{ media: "cdp" }} />
            }
          >
            CDP fallback
          </DropdownMenuItem>
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

function cdpUrlWithToken(cdpUrl: string, cdpToken: string) {
  const url = new URL(cdpUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(cdpToken)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
