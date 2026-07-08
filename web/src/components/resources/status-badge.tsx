import type { SessionStatus } from "#/lib/api/schemas.ts";
import { Badge } from "#/components/ui/badge.tsx";

const statusVariant: Record<SessionStatus, "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  creating: "secondary",
  suspended: "secondary",
  deleted: "outline",
  expired: "outline",
  failed: "destructive",
};

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  return <Badge variant={statusVariant[status]}>{status}</Badge>;
}

export function DeletedBadge({ deletedAt }: { deletedAt: string | null }) {
  if (!deletedAt) {
    return null;
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      deleted
    </Badge>
  );
}

export function RevokedBadge({ revokedAt }: { revokedAt: string | null }) {
  if (!revokedAt) {
    return null;
  }
  return <Badge variant="destructive">revoked</Badge>;
}
