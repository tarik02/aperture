import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@aperture-browser/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import { Plug, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { AccountSecurityDialog } from "#/features/auth/account-security-dialog.tsx";
import { usePersonQuery } from "#/features/auth/auth.queries.ts";
import { McpSetupDialog } from "#/features/mcp/mcp-setup-dialog.tsx";
import { useCloseDrawer } from "#/lib/drawer.ts";
import { type NavItem, primaryNavItems } from "#/lib/navigation.ts";

/** What is the account's own, whoever's workspace is shown: how it signs in and what acts for it. */
export function AccountSidebarGroup({ activeItem }: { activeItem: NavItem | undefined }) {
  const person = usePersonQuery();
  const [dialog, setDialog] = useState<"security" | "mcp" | null>(null);
  const closeDrawer = useCloseDrawer();
  const show = (which: "security" | "mcp") => {
    closeDrawer();
    setDialog(which);
  };

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Account</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {/* A second factor is a person's: a token signs in with nothing else. */}
          {person.data ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                data-console-security
                tooltip="Security"
                onClick={() => show("security")}
              >
                <ShieldCheck />
                <span data-sidebar-collapse-label>Security</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          {primaryNavItems
            .filter((item) => item.group === "account")
            .map((item) => (
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
          <SidebarMenuItem>
            <SidebarMenuButton
              data-console-mcp-open
              tooltip="Connect an MCP client"
              onClick={() => show("mcp")}
            >
              <Plug />
              <span data-sidebar-collapse-label>Connect an MCP client</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
      {person.data ? (
        <AccountSecurityDialog
          person={person.data}
          open={dialog === "security"}
          onOpenChange={(open) => setDialog(open ? "security" : null)}
        />
      ) : null}
      <McpSetupDialog
        open={dialog === "mcp"}
        onOpenChange={(open) => setDialog(open ? "mcp" : null)}
      />
    </SidebarGroup>
  );
}
