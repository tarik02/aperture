import { useQuery } from "@tanstack/react-query";
import { useMay } from "#/features/auth/access.ts";
import { call } from "#/lib/api.ts";
import { queryKeys } from "#/lib/query-keys.ts";

const listSnapshots = () => call((api) => api.snapshots.list({ query: {} }));

export type Snapshot = Awaited<ReturnType<typeof listSnapshots>>[number];

export function useSnapshotsQuery() {
  return useQuery({
    queryKey: queryKeys.snapshots,
    queryFn: listSnapshots,
    enabled: useMay("snapshots:read"),
  });
}
