import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  Building2,
  ChevronsUpDown,
  Fingerprint,
  LogOut,
  Palette,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { Avatar, AvatarFallback } from "@aperture-browser/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { SidebarMenuButton } from "@aperture-browser/ui/components/sidebar";
import { themeOptions, useThemeMode } from "#/components/theme-mode.ts";
import { ConnectedAppsModal } from "#/features/oauth/connected-apps-modal.tsx";
import { PasskeyModal } from "#/features/passkey/passkey-modal.tsx";
import { SecurityModal } from "#/features/security/security-modal.tsx";
import { PersonalTenantModal } from "#/features/tenant/personal-tenant-modal.tsx";
import { selectAuth, selectPrincipal, useAuthSessionStore } from "#/stores/auth-session.ts";
import { AuthApi } from "@aperture-browser/api-client";
import { useRunApi } from "@aperture-browser/session-react";

/** The account block at the foot of the sidebar: who is signed in, account settings and theme. */
export function AuthMenu() {
  const runApi = useRunApi();
  const queryClient = useQueryClient();
  const principal = useAuthSessionStore(selectPrincipal);
  const canManagePersonalTenant = Boolean(useAuthSessionStore(selectAuth)?.personalTenant);
  const setUnauthenticated = useAuthSessionStore((state) => state.setUnauthenticated);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [passkeysOpen, setPasskeysOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [connectedAppsOpen, setConnectedAppsOpen] = useState(false);
  const [personalTenantOpen, setPersonalTenantOpen] = useState(false);
  const { mode, changeMode } = useThemeMode();

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

  const accountBacked = principal?.type === "user";
  const name = principal?.name ?? "Account";
  const subtitle = !principal
    ? ""
    : principal.authorityType === "system_admin"
      ? "System admin"
      : accountBacked
        ? "Member"
        : "API token";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton
              size="lg"
              tooltip={name}
              disabled={!principal}
              className="aperture:data-popup-open:bg-sidebar-accent"
            />
          }
        >
          <Avatar className="aperture:size-8 aperture:rounded-lg">
            <AvatarFallback className="aperture:rounded-lg aperture:text-xs">
              {initials(name)}
            </AvatarFallback>
          </Avatar>
          <span
            data-sidebar-collapse-label
            className="aperture:grid aperture:min-w-0 aperture:flex-1"
          >
            <span className="aperture:truncate aperture:font-medium">{name}</span>
            <span className="aperture:truncate aperture:text-xs aperture:text-sidebar-foreground/60">
              {subtitle}
            </span>
          </span>
          <ChevronsUpDown
            data-sidebar-collapse-label
            className="aperture:ml-auto aperture:opacity-60"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="right" className="aperture:w-60">
          <DropdownMenuLabel className="aperture:grid aperture:font-normal">
            <span className="aperture:truncate aperture:font-medium aperture:text-foreground">
              {name}
            </span>
            <span className="aperture:truncate aperture:text-xs">{subtitle}</span>
          </DropdownMenuLabel>
          {accountBacked ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setSecurityOpen(true)}>
                <ShieldCheck />
                Security
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setPasskeysOpen(true)}>
                <Fingerprint />
                Passkeys
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setConnectedAppsOpen(true)}>
                <AppWindow />
                Connected apps
              </DropdownMenuItem>
              {canManagePersonalTenant ? (
                <DropdownMenuItem onClick={() => setPersonalTenantOpen(true)}>
                  <Building2 />
                  Personal tenant
                </DropdownMenuItem>
              ) : null}
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Palette />
                Theme
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="aperture:w-36">
                <DropdownMenuRadioGroup value={mode} onValueChange={changeMode}>
                  {themeOptions.map((option) => (
                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                      <option.icon />
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setLogoutOpen(true)}>
            <LogOut />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {accountBacked && principal ? (
        <>
          <SecurityModal open={securityOpen} onOpenChange={setSecurityOpen} />
          <PasskeyModal open={passkeysOpen} onOpenChange={setPasskeysOpen} />
          <ConnectedAppsModal open={connectedAppsOpen} onOpenChange={setConnectedAppsOpen} />
          {canManagePersonalTenant ? (
            <PersonalTenantModal open={personalTenantOpen} onOpenChange={setPersonalTenantOpen} />
          ) : null}
        </>
      ) : null}
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
    </>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}` : name.slice(0, 2);
  return letters.toUpperCase() || "?";
}
