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
  useSidebar,
} from "@aperture-browser/ui/components/sidebar";
import { Button } from "@aperture-browser/ui/components/button";
import { X } from "lucide-react";
import { useEffect } from "react";
import { useCloseDrawer } from "#/lib/drawer.ts";
import { Link, useRouterState } from "@tanstack/react-router";
import { ApertureMark } from "#/components/aperture-mark.tsx";
import { AuthMenu } from "#/components/auth-menu.tsx";
import { ThemeToggle } from "#/components/theme-toggle.tsx";
import { AccountSidebarGroup } from "#/features/auth/account-sidebar-group.tsx";
import { useAccess } from "#/features/auth/access.ts";
import { RecentSessionsSidebarGroup } from "#/features/session/recent-sessions-sidebar-group.tsx";
import { WorkspaceSwitcher } from "#/features/workspace/workspace-switcher.tsx";
import { type NavItem, primaryNavItems, resolveNavItem } from "#/lib/navigation.ts";

/**
 * The app navigation. Collapsed off canvas, it slides out while the pointer rests on the left
 * edge, so a full-width page can still reach it.
 */
export function AppSidebar({ collapsible }: { collapsible: "icon" | "offcanvas" }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const access = useAccess();
  const activeItem = resolveNavItem(pathname);
  const { isMobile } = useSidebar();
  const closeDrawer = useCloseDrawer();
  // Wherever the page went, the drawer is not left over it.
  useEffect(closeDrawer, [pathname, closeDrawer]);

  return (
    <Sidebar collapsible={collapsible} peekOnHover={collapsible === "offcanvas"}>
      <SidebarHeader className="aperture:gap-2">
        <div
          data-app-sidebar-titlebar=""
          className="aperture:flex aperture:h-10 aperture:items-center aperture:gap-2.5 aperture:group-data-[collapsible=icon]:gap-0"
        >
          <div
            data-sidebar-logo=""
            className="aperture:grid aperture:size-8 aperture:shrink-0 aperture:place-items-center aperture:rounded-lg aperture:bg-primary aperture:text-primary-foreground"
          >
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
          {isMobile ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close the menu"
              data-console-drawer-close
              className="aperture:ml-auto"
              onClick={closeDrawer}
            >
              <X />
            </Button>
          ) : null}
        </div>
        <WorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <NavGroup
          label="Workspace"
          items={primaryNavItems.filter(
            (item) => item.group === "workspace" && access.offers(item),
          )}
          activeItem={activeItem}
        />
        <AccountSidebarGroup activeItem={activeItem} />
        {access.may("admin") ? (
          <NavGroup
            label="Administration"
            items={primaryNavItems.filter((item) => item.group === "admin" && access.offers(item))}
            activeItem={activeItem}
          />
        ) : null}
        <RecentSessionsSidebarGroup pathname={pathname} />
      </SidebarContent>
      <SidebarFooter className="aperture:gap-2">
        <ThemeToggle />
        <AuthMenu icons={collapsible === "icon"} />
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
  const closeDrawer = useCloseDrawer();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                isActive={item === activeItem}
                render={<Link to={item.to} onClick={closeDrawer} />}
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
