import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@aperture-browser/ui/components/sidebar";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import { forget } from "#/lib/api.ts";
import { keepToken } from "#/lib/token.ts";

/** Who is signed in, and the way out. */
export function AuthMenu() {
  const account = useAccountQuery();
  const queries = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const signOut = () => {
    void forget();
    keepToken(undefined);
    queries.clear();
  };

  return (
    <SidebarMenu>
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
      <ConfirmDialog
        open={confirming}
        title="Sign out?"
        description="This browser forgets the token it was signed in with."
        confirmLabel="Sign out"
        onOpenChange={setConfirming}
        onConfirm={signOut}
      />
    </SidebarMenu>
  );
}
