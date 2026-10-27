import { useQueryClient } from "@tanstack/react-query";
import * as Effect from "effect/Effect";
import { Pause, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  SessionsApi,
  SnapshotsApi,
  type ApiCredentials,
  type ApiServices,
  type Session,
  type Snapshot,
} from "@aperture-browser/api-client";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import type { BulkAction } from "#/components/resources/selection-context-menu.tsx";
import { useTenantApi } from "#/hooks/use-tenant-api.ts";
import { isReopenable } from "#/features/session/session-display.ts";

type Confirm = { title: string; description: string; label: string; run: () => Promise<void> };

/**
 * Runs one API call per item, a few at a time, and reports the outcome in a single toast
 * instead of one per item.
 */
function useBulkRunner() {
  const api = useTenantApi();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  async function run<T>(
    items: readonly T[],
    verb: string,
    noun: (count: number) => string,
    call: (item: T, credentials: ApiCredentials) => Effect.Effect<unknown, unknown, ApiServices>,
    invalidate: readonly string[],
  ) {
    setPending(true);
    try {
      const results = await api.run((credentials) =>
        Effect.forEach(items, (item) => Effect.result(call(item, credentials)), {
          concurrency: 4,
        }),
      );
      const failed = results.filter((result) => result._tag === "Failure").length;
      const done = items.length - failed;
      if (failed === 0) {
        toast.success(`${verb} ${done} ${noun(done)}`);
      } else {
        toast.error(`${verb} ${done} of ${items.length} ${noun(items.length)}`, {
          description: `${failed} failed. Open them one by one to see why.`,
        });
      }
    } finally {
      setPending(false);
      for (const key of invalidate) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    }
  }

  return { run, pending };
}

const plural = (one: string) => (count: number) => (count === 1 ? one : `${one}s`);
const sessionKeys = ["sessions", "session", "sessions-bulk", "browser-status", "events"];

export function useSessionBulkActions(selected: readonly Session[], clear: () => void) {
  const { run, pending } = useBulkRunner();
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const running = selected.filter((session) => session.status === "running");
  const reopenable = selected.filter((session) => isReopenable(session.status));

  const actions: BulkAction[] = [
    {
      key: "suspend",
      label: "Suspend",
      icon: Pause,
      count: running.length,
      run: () =>
        void run(
          running,
          "Suspended",
          plural("session"),
          (session, credentials) =>
            SessionsApi.use((api) => api.suspendSession(credentials, session.id)),
          sessionKeys,
        ).then(clear),
    },
    {
      key: "reopen",
      label: "Reopen",
      icon: RotateCcw,
      count: reopenable.length,
      run: () =>
        void run(
          reopenable,
          "Reopened",
          plural("session"),
          (session, credentials) =>
            SessionsApi.use((api) => api.reopenSession(credentials, session.id)),
          sessionKeys,
        ).then(clear),
    },
    {
      key: "delete",
      label: "Delete",
      icon: Trash2,
      count: selected.length,
      destructive: true,
      run: () =>
        setConfirm({
          title: `Delete ${selected.length} ${plural("session")(selected.length)}?`,
          description:
            "Their browsers stop and their files, recordings and logs are removed. Snapshots saved from them are not affected. This cannot be undone.",
          label: "Delete",
          run: () =>
            run(
              selected,
              "Deleted",
              plural("session"),
              (session, credentials) =>
                SessionsApi.use((api) => api.deleteSession(credentials, session.id)),
              sessionKeys,
            ).then(clear),
        }),
    },
  ];

  return {
    actions,
    pending,
    dialog: <BulkConfirm confirm={confirm} pending={pending} onClose={() => setConfirm(null)} />,
  };
}

export function useSnapshotBulkActions(selected: readonly Snapshot[], clear: () => void) {
  const { run, pending } = useBulkRunner();
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const active = selected.filter((snapshot) => !snapshot.deletedAt);
  const deleted = selected.filter((snapshot) => Boolean(snapshot.deletedAt));

  const actions: BulkAction[] = [
    {
      key: "restore",
      label: "Restore",
      icon: RotateCcw,
      count: deleted.length,
      run: () =>
        void run(
          deleted,
          "Restored",
          plural("snapshot"),
          (snapshot, credentials) =>
            SnapshotsApi.use((api) => api.restoreSnapshot(credentials, snapshot.name)),
          ["snapshots", "events"],
        ).then(clear),
    },
    {
      key: "delete",
      label: "Delete",
      icon: Trash2,
      count: active.length,
      destructive: true,
      run: () =>
        setConfirm({
          title: `Delete ${active.length} ${plural("snapshot")(active.length)}?`,
          description:
            "New sessions can no longer start from them. Sessions already started from them are not affected.",
          label: "Delete",
          run: () =>
            run(
              active,
              "Deleted",
              plural("snapshot"),
              (snapshot, credentials) =>
                SnapshotsApi.use((api) => api.deleteSnapshot(credentials, snapshot.name)),
              ["snapshots", "events"],
            ).then(clear),
        }),
    },
  ];

  return {
    actions,
    pending,
    dialog: <BulkConfirm confirm={confirm} pending={pending} onClose={() => setConfirm(null)} />,
  };
}

function BulkConfirm({
  confirm,
  pending,
  onClose,
}: {
  confirm: Confirm | null;
  pending: boolean;
  onClose: () => void;
}) {
  return (
    <ConfirmDialog
      open={confirm !== null}
      title={confirm?.title ?? ""}
      description={confirm?.description ?? ""}
      confirmLabel={confirm?.label ?? "Confirm"}
      variant="destructive"
      pending={pending}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      onConfirm={async () => {
        await confirm?.run();
      }}
    />
  );
}
