import type { LucideIcon } from "lucide-react";
import { AppWindow, Building2, Camera, KeyRound } from "lucide-react";

export type NavItem = {
  title: string;
  to: string;
  icon: LucideIcon;
  adminOnly?: boolean;
};

export const primaryNavItems: NavItem[] = [
  { title: "Sessions", to: "/-/sessions", icon: AppWindow },
  { title: "Snapshots", to: "/-/snapshots", icon: Camera },
  { title: "Tokens", to: "/-/tokens", icon: KeyRound },
  { title: "Tenants", to: "/-/tenants", icon: Building2, adminOnly: true },
];
