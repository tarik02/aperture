import { CopyField } from "#/components/resources/copy-field.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import type { Session } from "#/lib/api/schemas.ts";
import { useRotateCdpTokenMutation } from "#/hooks/mutations/use-session-mutations.ts";

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

  const apiProxyUrl = `/api/cdp/${session.id}`;
  const rawCdpUrl = transientCdp?.cdpUrl ?? session.cdpUrl;

  async function handleRotate() {
    const result = await rotateMutation.mutateAsync(session.id);
    if (result.cdpUrl && result.cdpToken && onRotate) {
      onRotate({ cdpUrl: result.cdpUrl, cdpToken: result.cdpToken });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Connection</h3>
      <CopyField value={apiProxyUrl} label="API CDP" />
      {rawCdpUrl ? <CopyField value={rawCdpUrl} label="Raw CDP" /> : null}
      {transientCdp?.cdpToken ? (
        <CopyField value={transientCdp.cdpToken} label="CDP token" />
      ) : null}
      <Separator />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="whitespace-nowrap"
        onClick={() => void handleRotate()}
        disabled={rotateMutation.isPending || session.status !== "running"}
      >
        Rotate CDP token
      </Button>
    </div>
  );
}
