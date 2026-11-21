import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { SignInPage } from "./features/auth/sign-in-page.tsx";
import { SessionPage } from "./features/sessions/session-page.tsx";
import { SessionsPage } from "./features/sessions/sessions-page.tsx";
import { useToken } from "./lib/token.ts";

/** Nothing is shown to whoever is not signed in but the way in. */
function Signed() {
  return useToken() === undefined ? <SignInPage /> : <Outlet />;
}

const root = createRootRoute({ component: Signed });

const sessions = createRoute({ getParentRoute: () => root, path: "/", component: SessionsPage });

const session = createRoute({
  getParentRoute: () => root,
  path: "/sessions/$id",
  component: function Opened() {
    return <SessionPage id={session.useParams().id} />;
  },
});

export const router = createRouter({ routeTree: root.addChildren([sessions, session]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
