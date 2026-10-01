import { Link, useRouterState } from "@tanstack/react-router";
import { SelectedTenantControl } from "#/components/selected-tenant-control.tsx";
import { ThemeSwitcher } from "#/components/theme-switcher.tsx";
import { AuthMenu } from "#/components/auth-menu.tsx";
import { RecentSessionsSidebarGroup } from "#/features/session/recent-sessions-sidebar-group.tsx";
import { primaryNavItems } from "#/lib/navigation.ts";
import { selectIsSystemAdmin, useAuthSessionStore } from "#/stores/auth-session.ts";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@aperture-browser/ui/components/sidebar";

function isNavActive(pathname: string, to: string) {
  if (to === "/") {
    return pathname === "/";
  }

  return pathname === to || pathname.startsWith(`${to}/`);
}

export function AppSidebar() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isSystemAdmin = useAuthSessionStore(selectIsSystemAdmin);
  const navItems = primaryNavItems.filter((item) => !item.adminOnly || isSystemAdmin);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="aperture:border-b aperture:border-sidebar-border">
        <div
          data-app-sidebar-titlebar
          className="aperture:flex aperture:items-center aperture:gap-2 aperture:group-data-[collapsible=icon]:gap-0"
        >
          <div className="aperture:flex aperture:size-7 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-md aperture:bg-sidebar-primary aperture:text-sidebar-primary-foreground">
            <span className="aperture:text-xs aperture:font-semibold">A</span>
          </div>
          <span
            data-sidebar-collapse-label
            className="aperture:min-w-0 aperture:truncate aperture:text-sm aperture:font-semibold"
          >
            Aperture
          </span>
        </div>
        <div className="aperture:flex aperture:flex-col aperture:gap-1">
          <SelectedTenantControl
            triggerClassName="aperture:h-8 aperture:w-full aperture:max-w-none aperture:justify-start aperture:group-data-[collapsible=icon]:gap-0"
            align="start"
          />
          <AuthMenu />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="aperture:p-1.5">
          <SidebarGroupContent>
            <SidebarMenu className="aperture:gap-1">
              {navItems.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    isActive={isNavActive(pathname, item.to)}
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
        <RecentSessionsSidebarGroup pathname={pathname} />
      </SidebarContent>
      <SidebarFooter className="aperture:border-t aperture:border-sidebar-border">
        <ThemeSwitcher />
      </SidebarFooter>
    </Sidebar>
  );
}
