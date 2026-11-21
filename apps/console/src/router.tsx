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
import { useToken } from "#/lib/token.ts";

/** Nothing is shown to whoever is not signed in but the way in. */
function Signed() {
  return useToken() === undefined ? <SignInPage /> : <Outlet />;
}

const root = createRootRoute({ component: Signed });

const index = createRoute({
  getParentRoute: () => root,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/-/sessions" });
  },
});

const pages = createRoute({
  getParentRoute: () => root,
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

const nodes = createRoute({ getParentRoute: () => pages, path: "/-/nodes", component: NodesPage });

const accounts = createRoute({
  getParentRoute: () => pages,
  path: "/-/accounts",
  component: AccountsPage,
});

const session = createRoute({
  getParentRoute: () => root,
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
    index,
    pages.addChildren([sessions, snapshots, tokens, nodes, accounts]),
    session,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
