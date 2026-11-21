import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppShell } from "#/components/app-shell.tsx";
import { AccountsPage } from "#/features/account/accounts-page.tsx";
import { SignInPage } from "#/features/auth/sign-in-page.tsx";
import { NodesPage } from "#/features/node/nodes-page.tsx";
import { SessionWorkbench } from "#/features/session/session-workbench.tsx";
import { SessionsPage } from "#/features/session/sessions-page.tsx";
import { SnapshotsPage } from "#/features/snapshot/snapshots-page.tsx";
import { TokensPage } from "#/features/token/tokens-page.tsx";
import { WorkspacesPage } from "#/features/workspace/workspaces-page.tsx";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import { InvitePage } from "#/features/auth/invite-page.tsx";

/** Nothing is shown to whoever is not signed in but the way in. */
function Signed() {
  const account = useAccountQuery();
  if (account.isPending) {
    return null;
  }
  return account.isError ? <SignInPage /> : <Outlet />;
}

const root = createRootRoute();

const signed = createRoute({ getParentRoute: () => root, id: "signed", component: Signed });

const invite = createRoute({ getParentRoute: () => root, path: "/invite", component: InvitePage });

const index = createRoute({
  getParentRoute: () => signed,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/-/sessions" });
  },
});

const pages = createRoute({
  getParentRoute: () => signed,
  id: "pages",
  component: () => (
    <AppShell layout="page">
      <Outlet />
    </AppShell>
  ),
});

const sessions = createRoute({
  getParentRoute: () => pages,
  path: "/-/sessions",
  component: SessionsPage,
});

const snapshots = createRoute({
  getParentRoute: () => pages,
  path: "/-/snapshots",
  component: SnapshotsPage,
});

const tokens = createRoute({
  getParentRoute: () => pages,
  path: "/-/tokens",
  component: TokensPage,
});

const workspaces = createRoute({
  getParentRoute: () => pages,
  path: "/-/workspaces",
  component: WorkspacesPage,
});

const nodes = createRoute({ getParentRoute: () => pages, path: "/-/nodes", component: NodesPage });

const accounts = createRoute({
  getParentRoute: () => pages,
  path: "/-/accounts",
  component: AccountsPage,
});

const session = createRoute({
  getParentRoute: () => signed,
  path: "/-/sessions/$sessionId",
  component: function Opened() {
    return (
      <AppShell layout="workbench">
        <SessionWorkbench sessionId={session.useParams().sessionId} />
      </AppShell>
    );
  },
});

export const router = createRouter({
  routeTree: root.addChildren([
    invite,
    signed.addChildren([
      index,
      pages.addChildren([sessions, snapshots, tokens, workspaces, nodes, accounts]),
      session,
    ]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
