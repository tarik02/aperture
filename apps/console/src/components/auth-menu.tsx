import { Avatar, AvatarFallback } from "@aperture-browser/ui/components/avatar";
import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { useSidebar } from "@aperture-browser/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { themeOptions, useThemeMode } from "#/components/theme-mode.ts";
import { useAccess } from "#/features/auth/access.ts";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import { useCloseDrawer } from "#/lib/drawer.ts";
import { forget } from "#/lib/api.ts";
import { signOut as endSignIn } from "#/lib/identity.ts";
import { tellSigned } from "#/lib/sign.ts";
import { keepToken } from "#/lib/token.ts";

const initials = (name: string) => {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}` : name.slice(0, 2);
  return letters.toUpperCase() || "?";
};

/** Who is signed in, and the way out. */
export function AuthMenu({ icons }: { icons: boolean }) {
  const account = useAccountQuery();
  const queries = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const name = account.data?.name ?? "Account";
  const closeDrawer = useCloseDrawer();
  const access = useAccess();
  const { state, isMobile } = useSidebar();
  /** Whether the sidebar is drawn in to its icons, where it does that. */
  const narrow = icons && state === "collapsed" && !isMobile;
  const { mode, changeMode } = useThemeMode();

  const signOut = () => {
    void Promise.allSettled([forget(), endSignIn()]).then(() => {
      keepToken(undefined);
      tellSigned("out");
      queries.clear();
      // Whoever comes next starts from the way in, with nothing of this account's left.
      location.assign("/");
    });
  };

  const avatar = (
    <Avatar className="aperture:size-8 aperture:rounded-lg">
      <AvatarFallback className="aperture:rounded-lg aperture:text-xs">
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );

  return (
    <div className="aperture:flex aperture:items-center aperture:gap-2 aperture:rounded-lg aperture:p-1 aperture:group-data-[collapsible=icon]:p-0">
      {narrow ? (
        // Drawn in to its icons, the sidebar has no room for the theme and the way out:
        // they open from who is signed in.
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={`${name}: theme and sign out`}
                data-console-account-menu
                className="aperture:rounded-lg aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50"
              />
            }
          >
            {avatar}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="right"
            align="end"
            className="aperture:w-auto aperture:min-w-44"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>{name}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Theme</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={mode} onValueChange={changeMode}>
                {themeOptions.map((option) => (
                  <DropdownMenuRadioItem key={option.value} value={option.value}>
                    <option.icon />
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              data-console-sign-out
              onClick={() => setConfirming(true)}
            >
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        avatar
      )}
      <span data-sidebar-collapse-label className="aperture:grid aperture:min-w-0 aperture:flex-1">
        <span className="aperture:truncate aperture:text-sm aperture:font-medium">{name}</span>
        <span className="aperture:truncate aperture:text-xs aperture:text-sidebar-foreground/60">
          {/* What they may do here: an admin's token that is not for that makes no admin. */}
          {access.may("admin")
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
              onClick={() => {
                closeDrawer();
                setConfirming(true);
              }}
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
