import { Link, useRouterState } from "@tanstack/react-router";
import { SelectedTenantControl } from "#/components/selected-tenant-control.tsx";
import { ThemeSwitcher } from "#/components/theme-switcher.tsx";
import { TokenSwitcher } from "#/components/token-switcher.tsx";
import { primaryNavItems } from "#/lib/navigation.ts";
import {
  isSystemAdminProfile,
  selectActiveProfile,
  useTokenVaultStore,
} from "#/stores/token-vault.ts";
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
} from "#/components/ui/sidebar.tsx";

function isNavActive(pathname: string, to: string) {
  if (to === "/") {
    return pathname === "/";
  }

  return pathname === to || pathname.startsWith(`${to}/`);
}

export function AppSidebar() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const isSystemAdmin = isSystemAdminProfile(activeProfile);
  const navItems = primaryNavItems.filter((item) => !item.adminOnly || isSystemAdmin);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div
          data-app-sidebar-titlebar
          className="flex items-center gap-2 group-data-[collapsible=icon]:gap-0"
        >
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <span className="text-xs font-semibold">A</span>
          </div>
          <span data-sidebar-collapse-label className="min-w-0 truncate text-sm font-semibold">
            Aperture
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <SelectedTenantControl
            triggerClassName="h-8 w-full max-w-none justify-start group-data-[collapsible=icon]:gap-0"
            align="start"
          />
          <TokenSwitcher />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="p-1.5">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
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
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <ThemeSwitcher />
      </SidebarFooter>
    </Sidebar>
  );
}
