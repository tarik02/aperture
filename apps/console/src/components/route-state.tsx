import type { Scope } from "@aperture-browser/control-api";
import { Button } from "@aperture-browser/ui/components/button";
import { Link, type ErrorComponentProps } from "@tanstack/react-router";
import { ApertureMark } from "#/components/aperture-mark.tsx";
import { WindowTitlebar } from "#/components/window-titlebar.tsx";
import { useMay } from "#/features/auth/access.ts";
import { told } from "#/lib/api.ts";
import { useDocumentTitle } from "#/lib/document-title.ts";

type RouteStateProps = {
  title: string;
  note: string;
  children: React.ReactNode;
  action?: React.ReactNode;
};

/** What is said in a page's place where there is none to show, with the way back. */
function RouteState({ title, note, children, action }: RouteStateProps) {
  useDocumentTitle(title);
  return (
    <main
      data-console-route-state={note}
      className="aperture:flex aperture:h-full aperture:items-center aperture:justify-center aperture:bg-muted/40 aperture:p-4"
    >
      <WindowTitlebar over />
      <section className="aperture:flex aperture:w-full aperture:max-w-80 aperture:flex-col aperture:items-center aperture:gap-4 aperture:rounded-xl aperture:border aperture:bg-card aperture:p-6 aperture:text-center aperture:shadow-sm">
        <span className="aperture:grid aperture:size-10 aperture:place-items-center aperture:rounded-xl aperture:bg-primary aperture:text-primary-foreground">
          <ApertureMark className="aperture:size-5.5" />
        </span>
        <h1 className="aperture:text-base aperture:font-semibold">{title}</h1>
        <p className="aperture:max-w-full aperture:text-sm aperture:text-muted-foreground aperture:wrap-anywhere">
          {children}
        </p>
        <div className="aperture:flex aperture:flex-wrap aperture:justify-center aperture:gap-2">
          {action}
          <Button variant="outline" render={<Link to="/-/sessions" />}>
            All sessions
          </Button>
        </div>
      </section>
    </main>
  );
}

/**
 * A page of what not everyone may do, shown to nobody else who comes to its address: what
 * only an admin does, and what the token that is signed in with is not for.
 */
export function Only({ needs, children }: { needs: Scope; children: React.ReactNode }) {
  if (useMay(needs)) {
    return children;
  }
  return (
    <p
      data-console-not-allowed={needs}
      className="aperture:px-4 aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
    >
      {needs === "admin" ? "Only an admin sees this page." : "This token is not for this page."}
    </p>
  );
}

export function NotFound() {
  return (
    <RouteState title="Page not found" note="not-found">
      Nothing is at this address.
    </RouteState>
  );
}

export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <RouteState
      title="Something went wrong"
      note="error"
      action={
        <Button
          onClick={() => {
            reset();
            window.location.reload();
          }}
        >
          Reload
        </Button>
      }
    >
      {told(error, "The page failed to show.")}
    </RouteState>
  );
}
