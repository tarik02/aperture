import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppShell } from "#/components/app-shell.tsx";
import { NotFound, Only, RouteError } from "#/components/route-state.tsx";
import { PeoplePage } from "#/features/account/people-page.tsx";
import { ServiceAccountTokensPage } from "#/features/account/service-account-tokens-page.tsx";
import { ServiceAccountsPage } from "#/features/account/service-accounts-page.tsx";
import { SignInPage } from "#/features/auth/sign-in-page.tsx";
import { EventsPage } from "#/features/event/events-page.tsx";
import { ConnectedAppsPage } from "#/features/oauth/connected-apps-page.tsx";
import { ConsentPage } from "#/features/oauth/consent-page.tsx";
import { NodesPage } from "#/features/node/nodes-page.tsx";
import { RegistrationTokensPage } from "#/features/node/registration-tokens-page.tsx";
import { isNewSession } from "#/features/session/new-sessions.ts";
import { NewSessionWorkbench, SessionWorkbench } from "#/features/session/session-workbench.tsx";
import { SessionsPage } from "#/features/session/sessions-page.tsx";
import { GuestPage } from "#/features/share/guest-page.tsx";
import { SnapshotsPage } from "#/features/snapshot/snapshots-page.tsx";
import { TokensPage } from "#/features/token/tokens-page.tsx";
import { WorkspacesPage } from "#/features/workspace/workspaces-page.tsx";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import { InvitePage } from "#/features/auth/invite-page.tsx";
import { useDeployWatch } from "#/lib/deploy-watch.ts";
import { useKeyboardInset } from "#/lib/keyboard-inset.ts";
import { useWindowControlsOverlay } from "#/lib/window-controls-overlay.ts";

/** Nothing is shown to whoever is not signed in but the way in. */
function Signed() {
  const account = useAccountQuery();
  if (account.isPending) {
    return null;
  }
  return account.isError ? <SignInPage /> : <Outlet />;
}

/** What every page has: the window it is in, and word of a newer build. */
function Root() {
  useWindowControlsOverlay();
  useDeployWatch();
  useKeyboardInset();
  return <Outlet />;
}

const root = createRootRoute({ component: Root });

const signed = createRoute({ getParentRoute: () => root, id: "signed", component: Signed });

const invite = createRoute({ getParentRoute: () => root, path: "/invite", component: InvitePage });

// Bare, and outside what asks who is signed in: a guest has no account.
const share = createRoute({
  getParentRoute: () => root,
  path: "/share/$shareId",
  component: function Shared() {
    const { shareId } = share.useParams();
    return <GuestPage shareId={shareId} />;
  },
});

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
  component: () => (
    <Only needs="sessions:read">
      <SessionsPage />
    </Only>
  ),
});

const snapshots = createRoute({
  getParentRoute: () => pages,
  path: "/-/snapshots",
  component: () => (
    <Only needs="snapshots:read">
      <SnapshotsPage />
    </Only>
  ),
});

const tokens = createRoute({
  getParentRoute: () => pages,
  path: "/-/tokens",
  component: () => (
    <Only needs="tokens:write">
      <TokensPage />
    </Only>
  ),
});

const connectedApps = createRoute({
  getParentRoute: () => pages,
  path: "/-/connected-apps",
  component: () => (
    <Only needs="tokens:write">
      <ConnectedAppsPage />
    </Only>
  ),
});

// Bare, as signing in is: whoever comes is sent by an app, and goes back to it.
const consent = createRoute({
  getParentRoute: () => signed,
  path: "/oauth/consent",
  component: ConsentPage,
});

const workspaces = createRoute({
  getParentRoute: () => pages,
  path: "/-/workspaces",
  component: WorkspacesPage,
});

const nodes = createRoute({
  getParentRoute: () => pages,
  path: "/-/nodes",
  component: () => (
    <Only needs="admin">
      <NodesPage />
    </Only>
  ),
});

const registrationTokens = createRoute({
  getParentRoute: () => pages,
  path: "/-/registration-tokens",
  component: () => (
    <Only needs="admin">
      <RegistrationTokensPage />
    </Only>
  ),
});

const people = createRoute({
  getParentRoute: () => pages,
  path: "/-/people",
  component: () => (
    <Only needs="admin">
      <PeoplePage />
    </Only>
  ),
});

const serviceAccounts = createRoute({
  getParentRoute: () => pages,
  path: "/-/service-accounts",
  component: () => (
    <Only needs="admin">
      <ServiceAccountsPage />
    </Only>
  ),
});

const serviceAccountTokens = createRoute({
  getParentRoute: () => pages,
  path: "/-/service-accounts/$accountId/tokens",
  component: function Tokens() {
    const { accountId } = serviceAccountTokens.useParams();
    return (
      <Only needs="admin">
        <ServiceAccountTokensPage accountId={accountId} />
      </Only>
    );
  },
});

const events = createRoute({
  getParentRoute: () => pages,
  path: "/-/events",
  component: () => (
    <Only needs="events:read">
      <EventsPage />
    </Only>
  ),
});

const session = createRoute({
  getParentRoute: () => signed,
  path: "/-/sessions/$sessionId",
  component: function Opened() {
    const { sessionId } = session.useParams();
    return (
      <AppShell layout="workbench">
        {isNewSession(sessionId) ? (
          <NewSessionWorkbench sessionKey={sessionId} />
        ) : (
          <SessionWorkbench sessionId={sessionId} />
        )}
      </AppShell>
    );
  },
});

export const router = createRouter({
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: NotFound,
  routeTree: root.addChildren([
    invite,
    share,
    signed.addChildren([
      index,
      pages.addChildren([
        sessions,
        snapshots,
        tokens,
        connectedApps,
        workspaces,
        nodes,
        registrationTokens,
        people,
        serviceAccounts,
        serviceAccountTokens,
        events,
      ]),
      session,
      consent,
    ]),
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
