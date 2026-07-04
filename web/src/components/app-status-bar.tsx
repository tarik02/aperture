import { Badge } from "#/components/ui/badge.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";

export function AppStatusBar() {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="truncate text-sm font-medium">Aperture</span>
      <div className="ml-auto flex items-center gap-2">
        <Badge variant="outline">API unknown</Badge>
        <Badge variant="secondary">No token</Badge>
        <Skeleton className="hidden h-7 w-24 sm:block" />
      </div>
    </div>
  );
}
