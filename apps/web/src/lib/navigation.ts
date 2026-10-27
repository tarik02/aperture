import type { LucideIcon } from "lucide-react";
import { AppWindow, Building2, KeyRound, Layers, Users } from "lucide-react";

export type NavItem = {
  title: string;
  to: string;
  /** Search params that tell this item apart from another one on the same path. */
  search?: { view?: "snapshots" };
  icon: LucideIcon;
  group: "workspace" | "admin";
  adminOnly?: boolean;
  /** The page lists resources of the selected tenant. */
  tenantScoped?: boolean;
};

export const primaryNavItems: NavItem[] = [
  { title: "Sessions", to: "/-/sessions", icon: AppWindow, group: "workspace", tenantScoped: true },
  {
    title: "Snapshots",
    to: "/-/sessions",
    search: { view: "snapshots" },
    icon: Layers,
    group: "workspace",
    tenantScoped: true,
  },
  { title: "Tokens", to: "/-/tokens", icon: KeyRound, group: "workspace", tenantScoped: true },
  { title: "Tenants", to: "/-/tenants", icon: Building2, group: "admin", adminOnly: true },
  { title: "Users", to: "/-/users", icon: Users, group: "admin", adminOnly: true },
];

/** The item for a location; on a shared path, the one whose search matches wins. */
export function resolveNavItem(pathname: string, view: string | undefined) {
  const onPath = primaryNavItems.filter(
    (item) => pathname === item.to || pathname.startsWith(`${item.to}/`),
  );
  return onPath.find((item) => item.search?.view === view) ?? onPath[0];
}
