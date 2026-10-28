import { Link, useRouterState } from "@tanstack/react-router";
import { PlugZap } from "lucide-react";
import { useState } from "react";
import { AccountSidebarGroup, AuthMenu, ThemeToggle } from "#/components/auth-menu.tsx";
import { SelectedTenantControl } from "#/components/selected-tenant-control.tsx";
import { McpSetupDialog } from "#/features/mcp/mcp-setup-dialog.tsx";
import { RecentSessionsSidebarGroup } from "#/features/session/recent-sessions-sidebar-group.tsx";
import { primaryNavItems, resolveNavItem, type NavItem } from "#/lib/navigation.ts";
import { selectIsSystemAdmin, useAuthSessionStore } from "#/stores/auth-session.ts";
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

/**
 * The app navigation. Collapsed off canvas, it slides out while the pointer rests on the left
 * edge, so a full-width page can still reach it.
 */
export function AppSidebar({ collapsible }: { collapsible: "icon" | "offcanvas" }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const view = useRouterState({
    select: (state) => (state.location.search as { view?: string }).view,
  });
  const isSystemAdmin = useAuthSessionStore(selectIsSystemAdmin);
  const [mcpOpen, setMcpOpen] = useState(false);
  const activeItem = resolveNavItem(pathname, view);
  const items = primaryNavItems.filter((item) => !item.adminOnly || isSystemAdmin);
  const workspaceItems = items.filter((item) => item.group === "workspace");
  const adminItems = items.filter((item) => item.group === "admin");

  return (
    <Sidebar collapsible={collapsible} peekOnHover={collapsible === "offcanvas"}>
      <SidebarHeader className="aperture:gap-2">
        <div
          data-app-sidebar-titlebar
          className="aperture:flex aperture:h-10 aperture:items-center aperture:gap-2.5 aperture:group-data-[collapsible=icon]:gap-0"
        >
          <div className="aperture:grid aperture:size-8 aperture:shrink-0 aperture:place-items-center aperture:rounded-lg aperture:bg-sidebar-primary aperture:text-sidebar-primary-foreground">
            <ApertureMark />
          </div>
          <span data-sidebar-collapse-label className="aperture:grid aperture:min-w-0">
            <span className="aperture:truncate aperture:text-sm aperture:font-semibold">
              Aperture
            </span>
            <span className="aperture:truncate aperture:text-xs aperture:text-sidebar-foreground/60">
              {typeof window === "undefined" ? "" : window.location.host}
            </span>
          </span>
        </div>
        <SelectedTenantControl
          triggerClassName="aperture:h-8 aperture:w-full aperture:max-w-none aperture:justify-start aperture:group-data-[collapsible=icon]:gap-0"
          align="start"
        />
      </SidebarHeader>
      <SidebarContent>
        <NavGroup label="Workspace" items={workspaceItems} activeItem={activeItem} />
        {adminItems.length > 0 ? (
          <NavGroup label="Administration" items={adminItems} activeItem={activeItem} />
        ) : null}
        <NavGroup label="Integrations" items={[]} activeItem={activeItem}>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Connect an MCP client" onClick={() => setMcpOpen(true)}>
              <PlugZap />
              <span data-sidebar-collapse-label>Connect an MCP client</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </NavGroup>
        <AccountSidebarGroup />
        <RecentSessionsSidebarGroup pathname={pathname} />
      </SidebarContent>
      <SidebarFooter className="aperture:gap-2">
        <ThemeToggle />
        <AuthMenu />
      </SidebarFooter>
      <SidebarRail />
      <McpSetupDialog open={mcpOpen} onOpenChange={setMcpOpen} />
    </Sidebar>
  );
}

function NavGroup({
  label,
  items,
  activeItem,
  children,
}: {
  label: string;
  items: NavItem[];
  activeItem: NavItem | undefined;
  children?: React.ReactNode;
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
                render={<Link to={item.to} search={item.search ?? {}} />}
                tooltip={item.title}
              >
                <item.icon />
                <span data-sidebar-collapse-label>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {children}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** An aperture: six blades around an opening. */
function ApertureMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="aperture:size-4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m14.31 8 5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16 3.95 6.06M14.31 16H2.83M16.62 12l-5.74 9.94" />
    </svg>
  );
}
