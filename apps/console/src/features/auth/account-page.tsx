import { Tabs, TabsList, TabsTrigger } from "@aperture-browser/ui/components/tabs";
import { Link, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useAccountTabs } from "#/features/auth/account-tabs.ts";

/**
 * What is the account's own, whoever's workspace is shown: how it signs in and what acts
 * for it. Each kind is a tab with an address of its own, and holds one list at most.
 */
export function AccountPage() {
  const tabs = useAccountTabs();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const shown = tabs.find((tab) => pathname === tab.to || pathname.startsWith(`${tab.to}/`));

  return (
    <div className="aperture:flex aperture:h-full aperture:min-h-0 aperture:min-w-0 aperture:flex-col">
      {/* Whoever is offered none of it is told so by what the address shows. */}
      <Tabs
        value={shown?.id ?? null}
        className={
          tabs.length === 0
            ? "aperture:hidden"
            : "aperture:shrink-0 aperture:border-b aperture:px-3"
        }
      >
        <TabsList variant="line" className="aperture:h-10! aperture:max-w-full aperture:p-0">
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.id}
              value={tab.id}
              nativeButton={false}
              data-console-account-tab={tab.id}
              className="aperture:flex-none aperture:px-2.5 aperture:group-data-horizontal/tabs:after:bottom-0"
              render={<Link to={tab.to} />}
            >
              {tab.title}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="aperture:relative aperture:min-h-0 aperture:flex-1">
        <Outlet />
      </div>
    </div>
  );
}

/** The first of the tabs whoever is signed in is offered, for the bare address of the page. */
export function AccountHome() {
  const [first] = useAccountTabs();
  return first === undefined ? (
    <p
      data-console-not-allowed="account"
      className="aperture:px-4 aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
    >
      This token is not for this page.
    </p>
  ) : (
    <Navigate to={first.to} replace />
  );
}
