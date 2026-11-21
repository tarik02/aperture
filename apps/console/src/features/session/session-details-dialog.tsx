import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@aperture-browser/ui/components/tabs";
import { CopyField } from "#/components/copy-field.tsx";
import { TagList } from "#/components/tag-list.tsx";
import type { Session } from "#/features/session/session.queries.ts";
import { SessionStatusBadge } from "#/features/session/session-status-badge.tsx";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function Fact({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="aperture:text-muted-foreground">{name}</dt>
      <dd className="aperture:min-w-0 aperture:break-all">{children}</dd>
    </>
  );
}

type SessionDetailsDialogProps = {
  session: Session;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** What is known of a session, and how what is not a person reaches it. */
export function SessionDetailsDialog({ session, open, onOpenChange }: SessionDetailsDialogProps) {
  const base = session.path === null ? null : `${location.origin}${session.path}`;
  const mcp = base === null ? null : `${base}/mcp`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{session.label ?? "Session"}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="details">
          <TabsList>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="connection">Connection</TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="aperture:pt-2">
            <dl className="aperture:grid aperture:grid-cols-[auto_1fr] aperture:gap-x-4 aperture:gap-y-2 aperture:text-sm">
              <Fact name="State">
                <SessionStatusBadge session={session} />
              </Fact>
              <Fact name="Id">
                <span className="aperture:font-mono aperture:text-xs">{session.id}</span>
              </Fact>
              <Fact name="Snapshot">{session.snapshotId ?? "None"}</Fact>
              <Fact name="Node">{session.nodeId ?? "None"}</Fact>
              <Fact name="Created">
                {when.format(new Date(session.createdAt.epochMilliseconds))}
              </Fact>
              <Fact name="Last heard of">
                {when.format(new Date(session.observedAt.epochMilliseconds))}
              </Fact>
              {session.failure === null ? null : <Fact name="Failure">{session.failure}</Fact>}
              <Fact name="Tags">
                {Object.keys(session.tags).length === 0 ? "None" : <TagList tags={session.tags} />}
              </Fact>
            </dl>
          </TabsContent>
          <TabsContent value="connection" className="aperture:grid aperture:gap-4 aperture:pt-2">
            {base === null || mcp === null ? (
              <p className="aperture:text-sm aperture:text-muted-foreground">
                This session is on no node, so nothing reaches it.
              </p>
            ) : (
              <>
                <p className="aperture:text-sm aperture:text-muted-foreground">
                  Each takes an API token of this account as a bearer token, where the session
                  offers it.
                </p>
                <CopyField label="MCP" value={mcp} />
                <CopyField label="DevTools (CDP)" value={`${base.replace(/^http/u, "ws")}/cdp`} />
                <CopyField
                  label="Claude Code"
                  value={`claude mcp add --transport http aperture ${mcp} --header "Authorization: Bearer <API token>"`}
                />
              </>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
