import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronsUpDown,
  Fingerprint,
  KeyRound,
  LogOut,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { PasskeyModal } from "#/features/passkey/passkey-modal.tsx";
import { SecurityModal } from "#/features/security/security-modal.tsx";
import { apiClient } from "#/lib/api/client.ts";
import { cn } from "#/lib/utils.ts";
import { selectPrincipal, useAuthSessionStore } from "#/stores/auth-session.ts";

type AuthMenuProps = {
  className?: string;
};

export function AuthMenu({ className }: AuthMenuProps) {
  const queryClient = useQueryClient();
  const principal = useAuthSessionStore(selectPrincipal);
  const setUnauthenticated = useAuthSessionStore((state) => state.setUnauthenticated);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [passkeysOpen, setPasskeysOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await apiClient.logoutWebSession();
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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="default"
              className={cn(
                "w-full min-w-0 justify-start group-data-[collapsible=icon]:gap-0",
                className,
              )}
              disabled={!principal}
            />
          }
        >
          {accountBacked ? (
            <UserRound data-icon="inline-start" />
          ) : (
            <KeyRound data-icon="inline-start" />
          )}
          <span data-sidebar-collapse-label className="min-w-0 flex-1 truncate text-left">
            {principal?.name ?? "Account"}
          </span>
          <ChevronsUpDown
            data-icon="inline-end"
            data-sidebar-collapse-label
            className="opacity-60"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-64">
          <DropdownMenuLabel className="truncate">{principal?.name ?? "Account"}</DropdownMenuLabel>
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
            </>
          ) : null}
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
