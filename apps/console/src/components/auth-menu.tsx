import { Avatar, AvatarFallback } from "@aperture-browser/ui/components/avatar";
import { Button } from "@aperture-browser/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import { forget } from "#/lib/api.ts";
import { signOut as endSignIn } from "#/lib/identity.ts";
import { keepToken } from "#/lib/token.ts";

const initials = (name: string) => {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}` : name.slice(0, 2);
  return letters.toUpperCase() || "?";
};

/** Who is signed in, and the way out. */
export function AuthMenu() {
  const account = useAccountQuery();
  const queries = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const name = account.data?.name ?? "Account";

  const signOut = () => {
    void Promise.allSettled([forget(), endSignIn()]).then(() => {
      keepToken(undefined);
      queries.clear();
      // Whoever comes next starts from the way in, with nothing of this account's left.
      location.assign("/");
    });
  };

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
          {account.data?.admin === true
            ? "Admin"
            : account.data?.kind === "service"
              ? "Service account"
              : "Member"}
        </span>
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Sign out"
              data-console-sign-out
              onClick={() => setConfirming(true)}
              className="aperture:group-data-[collapsible=icon]:hidden"
            />
          }
        >
          <LogOut />
        </TooltipTrigger>
        <TooltipContent side="top">Sign out</TooltipContent>
      </Tooltip>
      <ConfirmDialog
        open={confirming}
        title="Sign out?"
        description="This browser forgets who was signed in."
        confirmLabel="Sign out"
        onOpenChange={setConfirming}
        onConfirm={signOut}
      />
    </div>
  );
}
