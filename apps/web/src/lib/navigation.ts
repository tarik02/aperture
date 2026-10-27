import type { LucideIcon } from "lucide-react";
import { AppWindow, Building2, KeyRound, Users } from "lucide-react";

export type NavItem = {
  title: string;
  to: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  /** The page lists resources of the selected tenant. */
  tenantScoped?: boolean;
};

export const primaryNavItems: NavItem[] = [
  { title: "Sessions", to: "/-/sessions", icon: AppWindow, tenantScoped: true },
  { title: "Tokens", to: "/-/tokens", icon: KeyRound, tenantScoped: true },
  { title: "Tenants", to: "/-/tenants", icon: Building2, adminOnly: true },
  { title: "Users", to: "/-/users", icon: Users, adminOnly: true },
];
