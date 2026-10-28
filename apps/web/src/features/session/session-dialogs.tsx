import { useNavigate } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { useMemo } from "react";
import { toast } from "sonner";
import { SessionsApi, type Session, type Snapshot } from "@aperture-browser/api-client";
import { copyText, useEffectCallback } from "@aperture-browser/session-react";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import {
  SessionDetailModals,
  type SessionDetailSection,
} from "#/components/sessions/session-detail-modals.tsx";
import { useApiCredentials } from "#/hooks/use-api-credentials.ts";
import { useDialogState } from "#/hooks/use-dialog-state.ts";
import { hasAllScopes, hasScope, useActiveScopes } from "#/hooks/use-scopes.ts";
import { McpSetupDialog } from "#/features/mcp/mcp-setup-dialog.tsx";
import { SessionProxyDialog } from "#/features/proxy/session-proxy-dialog.tsx";
import {
  SessionCreateDialog,
  type SessionCreateRequest,
} from "#/features/session/create-dialog/session-create-dialog.tsx";
import { sessionHref, useOpenSessions } from "#/features/session/open-sessions.ts";
import { sessionLabel } from "#/features/session/session-display.ts";
import {
  useDeleteSessionMutation,
  useReopenSessionMutation,
  useReplaceSessionTagsMutation,
  useRotateSessionTokenMutation,
  useSuspendSessionMutation,
} from "#/features/session/session.mutations.ts";
import { SnapshotEditDialog } from "#/features/snapshot/edit-dialog/snapshot-edit-dialog.tsx";
import {
  SaveToSnapshotDialog,
  type SaveToSnapshotRequest,
} from "#/features/snapshot/save-dialog/save-to-snapshot-dialog.tsx";
import {
  useDeleteSnapshotMutation,
  useRestoreSnapshotMutation,
} from "#/features/snapshot/snapshot.mutations.ts";

export interface SessionPermissions {
  readonly canWrite: boolean;
  readonly canSaveSnapshots: boolean;
}

export function useSessionPermissions(): SessionPermissions {
  const scopes = useActiveScopes();
  return {
    canWrite: hasScope(scopes, "sessions:write"),
    canSaveSnapshots: hasAllScopes(scopes, ["sessions:write", "snapshots:write"]),
  };
}

/**
 * Every session and snapshot dialog, with the actions that open them. The session list and the
 * workbench share it, so the same actions behave the same way in both.
 */
export function useSessionDialogs(
  options: {
    /** The session this tab shows, which counts as an open tab when saving it. */
    readonly currentSessionId?: string;
    readonly onSessionDeleted?: (session: Session) => void;
  } = {},
) {
  const navigate = useNavigate();
  const credentials = useApiCredentials();
  const permissions = useSessionPermissions();
  const openSessions = useOpenSessions();

  const create = useDialogState<SessionCreateRequest>();
  const save = useDialogState<SaveToSnapshotRequest>();
  const proxy = useDialogState<Session>();
  const deleteSession = useDialogState<Session>();
  const rotateToken = useDialogState<Session>();
  const mcp = useDialogState<{ session: Session | null }>();
  const details = useDialogState<{ session: Session; section: SessionDetailSection }>();
  const editSnapshot = useDialogState<Snapshot>();
  const deleteSnapshot = useDialogState<Snapshot>();

  const deleteSessionMutation = useDeleteSessionMutation();
  const suspendMutation = useSuspendSessionMutation();
  const reopenMutation = useReopenSessionMutation();
  const rotateMutation = useRotateSessionTokenMutation();
  const tagsMutation = useReplaceSessionTagsMutation();
  const deleteSnapshotMutation = useDeleteSnapshotMutation();
  const restoreSnapshotMutation = useRestoreSnapshotMutation();

  const copyShareUrl = useEffectCallback(
    (session: Session) =>
      Effect.gen(function* () {
        if (!credentials) {
          return;
        }
        const detailed = yield* SessionsApi.use((sessions) =>
          sessions.getSession(credentials, session.id),
        );
        const viewerToken = detailed.collaboration?.viewerToken;
        if (!viewerToken) {
          toast.error("This session has no viewer link");
          return;
        }
        const url = new URL("/share/", window.location.origin);
        url.hash = new URLSearchParams({ token: Redacted.value(viewerToken) }).toString();
        yield* copyText(url.toString());
        toast.success("Copied viewer link");
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            console.warn("Copy share URL failed", error);
            toast.error("Couldn't copy the viewer link");
          }),
        ),
      ),
    [credentials],
  );

  const copyLink = useEffectCallback(
    (session: Session, targetId?: string) =>
      copyText(new URL(sessionHref(session.id, targetId), window.location.origin).toString()).pipe(
        Effect.andThen(() => Effect.sync(() => toast.success("Copied link"))),
        Effect.catch(() => Effect.sync(() => toast.error("Couldn't copy the link"))),
      ),
    [],
  );

  const actions = useMemo(
    () => ({
      newSession: (request: SessionCreateRequest = {}) => create.show(request),
      saveToSnapshot: (session: Session, target?: Snapshot) =>
        save.show({
          session,
          target,
          openTabs:
            (openSessions.get(session.id)?.tabs ?? 0) +
            (options.currentSessionId === session.id ? 1 : 0),
        }),
      editProxy: (session: Session) => proxy.show(session),
      details: (session: Session, section: SessionDetailSection = "details") =>
        details.show({ session, section }),
      connectMcp: (session: Session | null = null) => mcp.show({ session }),
      deleteSession: (session: Session) => deleteSession.show(session),
      rotateToken: (session: Session) => rotateToken.show(session),
      suspend: (session: Session) => {
        suspendMutation.mutate(session.id, {
          onSuccess: () => toast.success(`Suspended ${sessionLabel(session)}`),
        });
      },
      reopen: (session: Session) => {
        reopenMutation.mutate(session.id, {
          onSuccess: (result) =>
            void navigate({
              to: "/-/sessions/$sessionId",
              params: { sessionId: result.session.id },
              // From a workbench, keep how it is shown, such as embedded or without WebRTC.
              search: options.currentSessionId === undefined ? undefined : true,
            }),
        });
      },
      copyLink,
      copyShareUrl,
      editSnapshot: (snapshot: Snapshot) => editSnapshot.show(snapshot),
      deleteSnapshot: (snapshot: Snapshot) => deleteSnapshot.show(snapshot),
      restoreSnapshot: (snapshot: Snapshot) => {
        restoreSnapshotMutation.mutate(snapshot.name, {
          onSuccess: () => toast.success(`Restored "${snapshot.name}"`),
        });
      },
    }),
    [
      copyLink,
      copyShareUrl,
      create,
      deleteSession,
      deleteSnapshot,
      details,
      editSnapshot,
      mcp,
      navigate,
      openSessions,
      options.currentSessionId,
      proxy,
      reopenMutation,
      restoreSnapshotMutation,
      rotateToken,
      save,
      suspendMutation,
    ],
  );

  const pending =
    suspendMutation.isPending ||
    reopenMutation.isPending ||
    deleteSessionMutation.isPending ||
    restoreSnapshotMutation.isPending;

  const dialogs = (
    <>
      <SessionCreateDialog
        key={`create-${create.key}`}
        request={create.data}
        {...create.rootProps}
      />
      <SaveToSnapshotDialog key={`save-${save.key}`} request={save.data} {...save.rootProps} />
      <SessionProxyDialog key={`proxy-${proxy.key}`} session={proxy.data} {...proxy.rootProps} />
      <McpSetupDialog session={mcp.data?.session ?? null} {...mcp.rootProps} />
      <SnapshotEditDialog
        key={`edit-snapshot-${editSnapshot.key}`}
        snapshot={editSnapshot.data}
        {...editSnapshot.rootProps}
      />
      <SessionDetailModals
        session={details.data?.session ?? null}
        section={details.open ? (details.data?.section ?? null) : null}
        onSectionChange={(section) => {
          if (section && details.data) {
            details.show({ session: details.data.session, section });
          } else {
            details.close();
          }
        }}
        onSessionChange={(session) =>
          details.data ? details.show({ session, section: details.data.section }) : undefined
        }
        actions={{
          canWrite: permissions.canWrite,
          canSaveSnapshot: permissions.canSaveSnapshots,
          deletePending: deleteSessionMutation.isPending,
          reopenPending: reopenMutation.isPending,
          suspendPending: suspendMutation.isPending,
          tagsPending: tagsMutation.isPending,
          rotatePending: rotateMutation.isPending,
          copySharePending: false,
          onDelete: (session) => {
            details.close();
            actions.deleteSession(session);
          },
          onSaveTags: async (session, tags) => {
            const result = await tagsMutation.mutateAsync({ sessionId: session.id, tags });
            toast.success("Tags saved");
            return result.session;
          },
          onSaveToSnapshot: (session) => {
            details.close();
            actions.saveToSnapshot(session);
          },
          onReopen: (session) => actions.reopen(session),
          onSuspend: (session) => actions.suspend(session),
          onRotate: (session) => actions.rotateToken(session),
          onCopyShareUrl: (session) => copyShareUrl(session),
        }}
      />
      <ConfirmDialog
        open={deleteSession.open}
        onOpenChange={deleteSession.rootProps.onOpenChange}
        onOpenChangeComplete={deleteSession.rootProps.onOpenChangeComplete}
        title={`Delete ${deleteSession.data ? sessionLabel(deleteSession.data) : "session"}?`}
        description="The browser stops and its files, recordings and logs are removed. Snapshots saved from it are not affected. This cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        pending={deleteSessionMutation.isPending}
        onConfirm={async () => {
          const session = deleteSession.data;
          if (!session) {
            return;
          }
          await deleteSessionMutation.mutateAsync(session.id);
          options.onSessionDeleted?.(session);
        }}
      />
      <ConfirmDialog
        open={rotateToken.open}
        onOpenChange={rotateToken.rootProps.onOpenChange}
        onOpenChangeComplete={rotateToken.rootProps.onOpenChangeComplete}
        title="Rotate session token?"
        description="The current session token stops working immediately. Clients using it, such as MCP clients set up with it, need the new one."
        confirmLabel="Rotate"
        pending={rotateMutation.isPending}
        onConfirm={async () => {
          const session = rotateToken.data;
          if (!session) {
            return;
          }
          const result = await rotateMutation.mutateAsync(session.id);
          toast.success("Session token rotated");
          details.show({ session: result.session, section: "connection" });
        }}
      />
      <ConfirmDialog
        open={deleteSnapshot.open}
        onOpenChange={deleteSnapshot.rootProps.onOpenChange}
        onOpenChangeComplete={deleteSnapshot.rootProps.onOpenChangeComplete}
        title={`Delete snapshot "${deleteSnapshot.data?.name ?? ""}"?`}
        description="New sessions can no longer start from it. Sessions already started from it are not affected."
        confirmLabel="Delete"
        variant="destructive"
        pending={deleteSnapshotMutation.isPending}
        onConfirm={async () => {
          const snapshot = deleteSnapshot.data;
          if (snapshot) {
            await deleteSnapshotMutation.mutateAsync(snapshot.name);
          }
        }}
      />
    </>
  );

  return { actions, dialogs, permissions, pending };
}

export type SessionActions = ReturnType<typeof useSessionDialogs>["actions"];
