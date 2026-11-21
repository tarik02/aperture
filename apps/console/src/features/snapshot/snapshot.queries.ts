import { useQuery } from "@tanstack/react-query";
import { call } from "#/lib/api.ts";
import { queryKeys } from "#/lib/query-keys.ts";

const listSnapshots = () => call((api) => api.snapshots.list());

export type Snapshot = Awaited<ReturnType<typeof listSnapshots>>[number];

export function useSnapshotsQuery() {
  return useQuery({ queryKey: queryKeys.snapshots, queryFn: listSnapshots });
}
