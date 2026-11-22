import type { Scope } from "@aperture-browser/control-api";
import type { LucideIcon } from "lucide-react";
import {
  AppWindow,
  Blocks,
  Bot,
  Building2,
  KeyRound,
  Layers,
  ScrollText,
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
    | "/-/service-accounts"
    | "/-/events";
  icon: LucideIcon;
  group: "workspace" | "account" | "admin";
  /** What whoever is signed in has to be let do for it to be shown; anyone, without. */
  needs?: Scope;
};

export const primaryNavItems: NavItem[] = [
  {
    title: "Sessions",
    to: "/-/sessions",
    icon: AppWindow,
    group: "workspace",
    needs: "sessions:read",
  },
  {
    title: "Snapshots",
    to: "/-/snapshots",
    icon: Layers,
    group: "workspace",
    needs: "snapshots:read",
  },
  { title: "Workspaces", to: "/-/workspaces", icon: Building2, group: "workspace" },
  { title: "API tokens", to: "/-/tokens", icon: KeyRound, group: "account", needs: "tokens:write" },
  {
    title: "Connected apps",
    to: "/-/connected-apps",
    icon: Blocks,
    group: "account",
    needs: "tokens:write",
  },
  { title: "Nodes", to: "/-/nodes", icon: Server, group: "admin", needs: "admin" },
  {
    title: "Registration tokens",
    to: "/-/registration-tokens",
    icon: Ticket,
    group: "admin",
    needs: "admin",
  },
  { title: "People", to: "/-/people", icon: Users, group: "admin", needs: "admin" },
  {
    title: "Service accounts",
    to: "/-/service-accounts",
    icon: Bot,
    group: "admin",
    needs: "admin",
  },
  { title: "Events", to: "/-/events", icon: ScrollText, group: "admin", needs: "events:read" },
];

export function resolveNavItem(pathname: string) {
  return primaryNavItems.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
}
