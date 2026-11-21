import type { LucideIcon } from "lucide-react";
import { AppWindow, Layers, Server, Users } from "lucide-react";

export type NavItem = {
  title: string;
  to: "/-/sessions" | "/-/snapshots" | "/-/nodes" | "/-/accounts";
  icon: LucideIcon;
  group: "workspace" | "admin";
  adminOnly?: boolean;
};

export const primaryNavItems: NavItem[] = [
  { title: "Sessions", to: "/-/sessions", icon: AppWindow, group: "workspace" },
  { title: "Snapshots", to: "/-/snapshots", icon: Layers, group: "workspace" },
  { title: "Nodes", to: "/-/nodes", icon: Server, group: "admin", adminOnly: true },
  { title: "Accounts", to: "/-/accounts", icon: Users, group: "admin", adminOnly: true },
];

export function resolveNavItem(pathname: string) {
  return primaryNavItems.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
}
