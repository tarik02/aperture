import type { LucideIcon } from "lucide-react";
import {
  AppWindow,
  Blocks,
  Bot,
  Building2,
  KeyRound,
  Layers,
  Server,
  Ticket,
  Users,
} from "lucide-react";

export type NavItem = {
  title: string;
  to:
    | "/-/sessions"
    | "/-/snapshots"
    | "/-/workspaces"
    | "/-/tokens"
    | "/-/connected-apps"
    | "/-/nodes"
    | "/-/registration-tokens"
    | "/-/people"
    | "/-/service-accounts";
  icon: LucideIcon;
  group: "workspace" | "account" | "admin";
};

export const primaryNavItems: NavItem[] = [
  { title: "Sessions", to: "/-/sessions", icon: AppWindow, group: "workspace" },
  { title: "Snapshots", to: "/-/snapshots", icon: Layers, group: "workspace" },
  { title: "Workspaces", to: "/-/workspaces", icon: Building2, group: "workspace" },
  { title: "API tokens", to: "/-/tokens", icon: KeyRound, group: "account" },
  { title: "Connected apps", to: "/-/connected-apps", icon: Blocks, group: "account" },
  { title: "Nodes", to: "/-/nodes", icon: Server, group: "admin" },
  { title: "Registration tokens", to: "/-/registration-tokens", icon: Ticket, group: "admin" },
  { title: "People", to: "/-/people", icon: Users, group: "admin" },
  { title: "Service accounts", to: "/-/service-accounts", icon: Bot, group: "admin" },
];

export function resolveNavItem(pathname: string) {
  return primaryNavItems.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
}
