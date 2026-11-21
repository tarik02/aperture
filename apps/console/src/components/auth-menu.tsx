import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@aperture-browser/ui/components/sidebar";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { AccountSecurityDialog } from "#/features/auth/account-security-dialog.tsx";
import { useAccountQuery, usePersonQuery } from "#/features/auth/auth.queries.ts";
import { forget } from "#/lib/api.ts";
import { signOut as endSignIn } from "#/lib/identity.ts";
import { keepToken } from "#/lib/token.ts";

/** Who is signed in, how a person among them proves it, and the way out. */
export function AuthMenu() {
  const account = useAccountQuery();
  const person = usePersonQuery();
  const queries = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [securing, setSecuring] = useState(false);

  const signOut = () => {
    void Promise.allSettled([forget(), endSignIn()]).then(() => {
      keepToken(undefined);
      queries.clear();
      // Whoever comes next starts from the way in, with nothing of this account's left.
      location.assign("/");
    });
  };

  return (
    <SidebarMenu>
      {person.data ? (
        <SidebarMenuItem>
          <SidebarMenuButton
            data-console-security
            tooltip="Account security"
            onClick={() => setSecuring(true)}
          >
            <ShieldCheck />
            <span data-sidebar-collapse-label>Account security</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
      <SidebarMenuItem>
        <SidebarMenuButton
          data-console-sign-out
          tooltip="Sign out"
          onClick={() => setConfirming(true)}
        >
          <LogOut />
          <span data-sidebar-collapse-label className="aperture:grid aperture:min-w-0">
            <span className="aperture:truncate aperture:text-sm">{account.data?.name}</span>
            <span className="aperture:truncate aperture:text-xs aperture:text-sidebar-foreground/60">
              {account.data?.admin === true ? "Admin" : "Account"}
            </span>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      {person.data ? (
        <AccountSecurityDialog person={person.data} open={securing} onOpenChange={setSecuring} />
      ) : null}
      <ConfirmDialog
        open={confirming}
        title="Sign out?"
        description="This browser forgets who was signed in."
        confirmLabel="Sign out"
        onOpenChange={setConfirming}
        onConfirm={signOut}
      />
    </SidebarMenu>
  );
}
