import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
} from "@tanstack/react-router";
import { AppShell } from "#/components/app-shell.tsx";
import { NotFound, Only, RouteError } from "#/components/route-state.tsx";
import { PeoplePage } from "#/features/account/people-page.tsx";
import { ServiceAccountTokensPage } from "#/features/account/service-account-tokens-page.tsx";
import { ServiceAccountsPage } from "#/features/account/service-accounts-page.tsx";
import { AccountHome, AccountPage } from "#/features/auth/account-page.tsx";
import { SecurityPage } from "#/features/auth/security-page.tsx";
import { SignInPage } from "#/features/auth/sign-in-page.tsx";
import { AUDIT_SEARCH, AuditPage } from "#/features/audit/audit-page.tsx";
import { ConnectedAppsPage } from "#/features/oauth/connected-apps-page.tsx";
import { ConsentPage } from "#/features/oauth/consent-page.tsx";
import { NodesPage } from "#/features/node/nodes-page.tsx";
import {
  REGISTRATION_TOKENS_SEARCH,
  RegistrationTokensPage,
} from "#/features/node/registration-tokens-page.tsx";
import { ProvidersPage } from "#/features/provider/providers-page.tsx";
import { isNewSession } from "#/features/session/new-sessions.ts";
import { NewSessionWorkbench, SessionWorkbench } from "#/features/session/session-workbench.tsx";
import { SESSIONS_SEARCH, SessionsPage } from "#/features/session/sessions-page.tsx";
import { GuestPage } from "#/features/share/guest-page.tsx";
import { SnapshotsPage } from "#/features/snapshot/snapshots-page.tsx";
import { TOKENS_SEARCH, TokensPage } from "#/features/token/tokens-page.tsx";
import { WorkspacesPage } from "#/features/workspace/workspaces-page.tsx";
import { useAccess } from "#/features/auth/access.ts";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import { InvitePage } from "#/features/auth/invite-page.tsx";
import { useDeployWatch } from "#/lib/deploy-watch.ts";
import { useKeyboardInset } from "@aperture-browser/ui/keyboard-inset";
import { listSearch } from "#/lib/list-search.ts";
import { primaryNavItems } from "#/lib/navigation.ts";
import { useSignChanges } from "#/lib/sign.ts";
import { useWindowControlsOverlay } from "#/lib/window-controls-overlay.ts";

/** Nothing is shown to whoever is not signed in but the way in. */
function Signed() {
  const account = useAccountQuery();
  // What was open for whoever was signed in before is not left open for the next.
  const changes = useSignChanges();
  if (account.isPending) {
    return null;
  }
  return account.isError ? <SignInPage /> : <Outlet key={changes} />;
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

/**
 * Where whoever comes to the bare address is sent: the first page they are offered, which
 * is the sessions for everyone but a token that is not for them.
 */
function Home() {
  const access = useAccess();
  const first = primaryNavItems.find((item) => access.offers(item));
  return <Navigate to={first?.to ?? "/-/workspaces"} replace />;
}

const index = createRoute({ getParentRoute: () => signed, path: "/", component: Home });

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
  validateSearch: listSearch(SESSIONS_SEARCH),
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

const account = createRoute({
  getParentRoute: () => pages,
  path: "/-/account",
  component: AccountPage,
});

const accountHome = createRoute({
  getParentRoute: () => account,
  path: "/",
  component: AccountHome,
});

const accountSecurity = createRoute({
  getParentRoute: () => account,
  path: "security",
  component: SecurityPage,
});

const accountTokens = createRoute({
  getParentRoute: () => account,
  path: "tokens",
  validateSearch: listSearch(TOKENS_SEARCH),
  component: () => (
    <Only needs="tokens:write">
      <TokensPage />
    </Only>
  ),
});

const accountConnections = createRoute({
  getParentRoute: () => account,
  path: "connections",
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
  validateSearch: listSearch(REGISTRATION_TOKENS_SEARCH),
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
  validateSearch: listSearch(TOKENS_SEARCH),
  component: function Tokens() {
    const { accountId } = serviceAccountTokens.useParams();
    return (
      <Only needs="admin">
        <ServiceAccountTokensPage accountId={accountId} />
      </Only>
    );
  },
});

const providers = createRoute({
  getParentRoute: () => pages,
  path: "/-/sign-in-providers",
  component: () => (
    <Only needs="admin">
      <ProvidersPage />
    </Only>
  ),
});

const audit = createRoute({
  getParentRoute: () => pages,
  path: "/-/audit",
  validateSearch: listSearch(AUDIT_SEARCH),
  component: () => (
    <Only needs="events:read">
      <AuditPage />
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
        account.addChildren([accountHome, accountSecurity, accountTokens, accountConnections]),
        workspaces,
        nodes,
        registrationTokens,
        people,
        serviceAccounts,
        serviceAccountTokens,
        providers,
        audit,
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
