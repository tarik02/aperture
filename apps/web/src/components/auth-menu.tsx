import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppWindow, Building2, Fingerprint, LogOut, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { AuthApi } from "@aperture-browser/api-client";
import { useRunApi } from "@aperture-browser/session-react";
import { Avatar, AvatarFallback } from "@aperture-browser/ui/components/avatar";
import { Button } from "@aperture-browser/ui/components/button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@aperture-browser/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { cn } from "@aperture-browser/ui/utils";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { themeOptions, useThemeMode } from "#/components/theme-mode.ts";
import { ConnectedAppsModal } from "#/features/oauth/connected-apps-modal.tsx";
import { PasskeyModal } from "#/features/passkey/passkey-modal.tsx";
import { SecurityModal } from "#/features/security/security-modal.tsx";
import { PersonalTenantModal } from "#/features/tenant/personal-tenant-modal.tsx";
import { selectAuth, selectPrincipal, useAuthSessionStore } from "#/stores/auth-session.ts";

type AccountModal = "security" | "passkeys" | "connected-apps" | "personal-tenant";

/** Account settings of a signed-in user, as a sidebar group. API tokens have none. */
export function AccountSidebarGroup() {
  const principal = useAuthSessionStore(selectPrincipal);
  const canManagePersonalTenant = Boolean(useAuthSessionStore(selectAuth)?.personalTenant);
  const [open, setOpen] = useState<AccountModal | null>(null);

  if (principal?.type !== "user") {
    return null;
  }

  const items: Array<{ key: AccountModal; title: string; icon: typeof ShieldCheck }> = [
    { key: "security", title: "Security", icon: ShieldCheck },
    { key: "passkeys", title: "Passkeys", icon: Fingerprint },
    { key: "connected-apps", title: "Connected apps", icon: AppWindow },
    ...(canManagePersonalTenant
      ? [{ key: "personal-tenant" as const, title: "Personal tenant", icon: Building2 }]
      : []),
  ];
  const setModalOpen = (key: AccountModal) => (next: boolean) => setOpen(next ? key : null);

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Account</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.key}>
              <SidebarMenuButton tooltip={item.title} onClick={() => setOpen(item.key)}>
                <item.icon />
                <span data-sidebar-collapse-label>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
      <SecurityModal open={open === "security"} onOpenChange={setModalOpen("security")} />
      <PasskeyModal open={open === "passkeys"} onOpenChange={setModalOpen("passkeys")} />
      <ConnectedAppsModal
        open={open === "connected-apps"}
        onOpenChange={setModalOpen("connected-apps")}
      />
      {canManagePersonalTenant ? (
        <PersonalTenantModal
          open={open === "personal-tenant"}
          onOpenChange={setModalOpen("personal-tenant")}
        />
      ) : null}
    </SidebarGroup>
  );
}

/** Light, dark or following the system, as three icon buttons. */
export function ThemeToggle() {
  const { mode, changeMode } = useThemeMode();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="aperture:flex aperture:gap-0.5 aperture:rounded-lg aperture:bg-sidebar-accent/60 aperture:p-0.5 aperture:group-data-[collapsible=icon]:hidden"
    >
      {themeOptions.map((option) => (
        <Tooltip key={option.value}>
          <TooltipTrigger
            render={
              <button
                type="button"
                role="radio"
                aria-checked={mode === option.value}
                aria-label={option.label}
                onClick={() => changeMode(option.value)}
                className={cn(
                  "aperture:flex aperture:h-6 aperture:flex-1 aperture:items-center aperture:justify-center aperture:rounded-md aperture:text-sidebar-foreground/60 aperture:transition-colors aperture:hover:text-sidebar-foreground aperture:[&_svg]:size-3.5",
                  mode === option.value &&
                    "aperture:bg-sidebar aperture:text-sidebar-foreground aperture:shadow-xs",
                )}
              />
            }
          >
            <option.icon />
          </TooltipTrigger>
          <TooltipContent side="top">{option.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/** Who is signed in, with a log out button. */
export function AuthMenu() {
  const runApi = useRunApi();
  const queryClient = useQueryClient();
  const principal = useAuthSessionStore(selectPrincipal);
  const setUnauthenticated = useAuthSessionStore((state) => state.setUnauthenticated);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await runApi(AuthApi.use((auth) => auth.logoutWebSession()));
      queryClient.clear();
      setUnauthenticated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Logout failed");
      throw error;
    } finally {
      setLoggingOut(false);
    }
  }

  const name = principal?.name ?? "Account";
  const subtitle = !principal
    ? ""
    : principal.authorityType === "system_admin"
      ? "System admin"
      : principal.type === "user"
        ? "Member"
        : "API token";

  return (
    <div className="aperture:flex aperture:items-center aperture:gap-2 aperture:rounded-lg aperture:p-1 aperture:group-data-[collapsible=icon]:p-0">
      <Avatar className="aperture:size-8 aperture:rounded-lg">
        <AvatarFallback className="aperture:rounded-lg aperture:text-xs">
          {initials(name)}
        </AvatarFallback>
      </Avatar>
      <span data-sidebar-collapse-label className="aperture:grid aperture:min-w-0 aperture:flex-1">
        <span className="aperture:truncate aperture:text-sm aperture:font-medium">{name}</span>
        <span className="aperture:truncate aperture:text-xs aperture:text-sidebar-foreground/60">
          {subtitle}
        </span>
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Log out"
              disabled={!principal}
              onClick={() => setLogoutOpen(true)}
              className="aperture:group-data-[collapsible=icon]:hidden"
            />
          }
        >
          <LogOut />
        </TooltipTrigger>
        <TooltipContent side="top">Log out</TooltipContent>
      </Tooltip>
      <ConfirmDialog
        open={logoutOpen}
        title="Log out"
        description={`Log out ${principal?.name ?? "of Aperture"}?`}
        confirmLabel="Log out"
        pending={loggingOut}
        variant="default"
        onOpenChange={setLogoutOpen}
        onConfirm={handleLogout}
      />
    </div>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}` : name.slice(0, 2);
  return letters.toUpperCase() || "?";
}
