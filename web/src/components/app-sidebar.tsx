import { Link, useRouterState } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { primaryNavItems } from "#/lib/navigation.ts";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
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
} from "#/components/ui/sidebar.tsx";

function isNavActive(pathname: string, to: string) {
  if (to === "/") {
    return pathname === "/";
  }

  return pathname === to || pathname.startsWith(`${to}/`);
}

export function AppSidebar() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader className="h-12 justify-center border-b border-sidebar-border">
        <div className="flex items-center gap-2 px-1">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <span className="text-xs font-semibold">A</span>
          </div>
          <div className="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-semibold">Aperture</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigate</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {primaryNavItems.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    isActive={isNavActive(pathname, item.to)}
                    render={<Link to={item.to} />}
                    size="sm"
                    tooltip={item.title}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                    {item.adminOnly ? (
                      <Badge
                        variant="outline"
                        className="ml-auto group-data-[collapsible=icon]:hidden"
                      >
                        Admin
                      </Badge>
                    ) : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
          disabled
        >
          <KeyRound data-icon="inline-start" />
          <span className="truncate group-data-[collapsible=icon]:hidden">No token</span>
        </Button>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
