import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@aperture-browser/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import { useAccess } from "#/features/auth/access.ts";
import { useAccountTabs } from "#/features/auth/account-tabs.ts";
import { useCloseDrawer } from "#/lib/drawer.ts";
import { type NavItem, primaryNavItems } from "#/lib/navigation.ts";

/** What is the account's own, whoever's workspace is shown: one page of it, and what it did. */
export function AccountSidebarGroup({ activeItem }: { activeItem: NavItem | undefined }) {
  const access = useAccess();
  const tabs = useAccountTabs();
  const closeDrawer = useCloseDrawer();
  const items = primaryNavItems.filter((item) =>
    item.to === "/-/account"
      ? tabs.length > 0
      : (item.group === "account" || (item.otherwise === "account" && !access.may("admin"))) &&
        access.offers(item),
  );
  if (items.length === 0) {
    return null;
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Account</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                isActive={item === activeItem}
                // How one signs in is there for a person alone.
                data-console-security={
                  item.to === "/-/account" && tabs.some((tab) => tab.id === "security")
                    ? ""
                    : undefined
                }
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
