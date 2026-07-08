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
import { useEffect, useMemo, useState } from "react";

export type TransientCdpCredentials = {
  cdpUrl: string;
  cdpToken: string;
} | null;

type ConnectionPanelProps = {
  session: Session;
  transientCdp: TransientCdpCredentials;
  onRotate?: (credentials: { cdpUrl: string; cdpToken: string }) => void;
};

export function ConnectionPanel({ session, transientCdp, onRotate }: ConnectionPanelProps) {
  const rotateMutation = useRotateCdpTokenMutation();
  const [publicOrigin, setPublicOrigin] = useState<string | null>(null);
  const [rotateConfirmOpen, setRotateConfirmOpen] = useState(false);

  const rawCdpUrl = transientCdp?.cdpUrl ?? session.cdpUrl;
  const cdpUrl = useMemo(
    () => (rawCdpUrl ? publicCdpUrl(rawCdpUrl, publicOrigin) : null),
    [publicOrigin, rawCdpUrl],
  );
  const tokenizedCdpUrl = useMemo(
    () =>
      cdpUrl && transientCdp?.cdpToken ? cdpUrlWithToken(cdpUrl, transientCdp.cdpToken) : null,
    [cdpUrl, transientCdp?.cdpToken],
  );
  const canOpen = session.status === "running";

  useEffect(() => {
    setPublicOrigin(window.location.origin);
  }, []);

  async function handleRotate() {
    const result = await rotateMutation.mutateAsync(session.id);
    if (result.cdpUrl && result.cdpToken && onRotate) {
      onRotate({ cdpUrl: result.cdpUrl, cdpToken: result.cdpToken });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Connection</h3>
      {cdpUrl ? <CopyField value={cdpUrl} label="CDP URL" /> : null}
      {transientCdp?.cdpToken ? <CopyField value={transientCdp.cdpToken} label="Token" /> : null}
      {tokenizedCdpUrl ? <CopyField value={tokenizedCdpUrl} label="CDP URL with token" /> : null}
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="whitespace-nowrap"
          onClick={() => setRotateConfirmOpen(true)}
          disabled={rotateMutation.isPending || session.status !== "running"}
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
