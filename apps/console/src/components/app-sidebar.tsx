import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@aperture-browser/ui/components/sidebar";
import { Link, useRouterState } from "@tanstack/react-router";
import { ApertureMark } from "#/components/aperture-mark.tsx";
import { AuthMenu } from "#/components/auth-menu.tsx";
import { ThemeToggle } from "#/components/theme-toggle.tsx";
import { AccountSidebarGroup } from "#/features/auth/account-sidebar-group.tsx";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import { RecentSessionsSidebarGroup } from "#/features/session/recent-sessions-sidebar-group.tsx";
import { WorkspaceSwitcher } from "#/features/workspace/workspace-switcher.tsx";
import { type NavItem, primaryNavItems, resolveNavItem } from "#/lib/navigation.ts";

/**
 * The app navigation. Collapsed off canvas, it slides out while the pointer rests on the left
 * edge, so a full-width page can still reach it.
 */
export function AppSidebar({ collapsible }: { collapsible: "icon" | "offcanvas" }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const account = useAccountQuery();
  const activeItem = resolveNavItem(pathname);

  return (
    <Sidebar collapsible={collapsible} peekOnHover={collapsible === "offcanvas"}>
      <SidebarHeader className="aperture:gap-2">
        <div className="aperture:flex aperture:h-10 aperture:items-center aperture:gap-2.5 aperture:group-data-[collapsible=icon]:gap-0">
          <div className="aperture:grid aperture:size-8 aperture:shrink-0 aperture:place-items-center aperture:rounded-lg aperture:bg-sidebar-primary aperture:text-sidebar-primary-foreground">
            <ApertureMark />
          </div>
          <span data-sidebar-collapse-label className="aperture:grid aperture:min-w-0">
            <span className="aperture:truncate aperture:text-sm aperture:font-semibold">
              Aperture
            </span>
            <span className="aperture:truncate aperture:text-xs aperture:text-sidebar-foreground/60">
              {window.location.host}
            </span>
          </span>
        </div>
        <WorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <NavGroup
          label="Workspace"
          items={primaryNavItems.filter((item) => item.group === "workspace")}
          activeItem={activeItem}
        />
        <AccountSidebarGroup activeItem={activeItem} />
        {account.data?.admin === true ? (
          <NavGroup
            label="Administration"
            items={primaryNavItems.filter((item) => item.group === "admin")}
            activeItem={activeItem}
          />
        ) : null}
        <RecentSessionsSidebarGroup pathname={pathname} />
      </SidebarContent>
      <SidebarFooter className="aperture:gap-2">
        <ThemeToggle />
        <AuthMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function NavGroup({
  label,
  items,
  activeItem,
}: {
  label: string;
  items: NavItem[];
  activeItem: NavItem | undefined;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                isActive={item === activeItem}
                render={<Link to={item.to} />}
                tooltip={item.title}
              >
                <item.icon />
                <span data-sidebar-collapse-label>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
