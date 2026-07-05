import { useState } from "react";
import { Check, ChevronsUpDown, KeyRound, Plus, Trash2 } from "lucide-react";
import { TokenFormDialog } from "#/components/token-form-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import {
  profileDisplayName,
  selectActiveProfile,
  useTokenVaultStore,
} from "#/stores/token-vault.ts";
import { cn } from "#/lib/utils.ts";

type TokenSwitcherProps = {
  className?: string;
};

export function TokenSwitcher({ className }: TokenSwitcherProps) {
  const profiles = useTokenVaultStore((state) => state.profiles);
  const activeProfile = useTokenVaultStore(selectActiveProfile);
  const setActiveProfile = useTokenVaultStore((state) => state.setActiveProfile);
  const removeProfile = useTokenVaultStore((state) => state.removeProfile);
  const bootstrapping = useTokenVaultStore((state) => state.bootstrapping);

  const [addOpen, setAddOpen] = useState(false);

  function handleSwitch(profileId: string) {
    if (profileId === activeProfile?.id) {
      return;
    }

    setActiveProfile(profileId);
  }

  function handleRemove(profileId: string) {
    removeProfile(profileId);
  }

  const triggerLabel = activeProfile ? profileDisplayName(activeProfile) : "No token";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "w-full min-w-0 justify-start group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0",
                className,
              )}
              disabled={bootstrapping}
            />
          }
        >
          <KeyRound data-icon="inline-start" />
          <span className="truncate group-data-[collapsible=icon]:hidden">{triggerLabel}</span>
          <ChevronsUpDown className="ml-auto size-3.5 opacity-60 group-data-[collapsible=icon]:hidden" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-64">
          <DropdownMenuLabel>Tokens</DropdownMenuLabel>
          {profiles.length === 0 ? (
            <DropdownMenuItem disabled>No saved tokens</DropdownMenuItem>
          ) : (
            profiles.map((profile) => (
              <DropdownMenuItem
                key={profile.id}
                onClick={() => handleSwitch(profile.id)}
                className="justify-between"
              >
                <span className="truncate">{profileDisplayName(profile)}</span>
                {profile.id === activeProfile?.id ? <Check className="size-3.5" /> : null}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAddOpen(true)}>
            <Plus />
            Add token
          </DropdownMenuItem>
          {activeProfile ? (
            <DropdownMenuItem variant="destructive" onClick={() => handleRemove(activeProfile.id)}>
              <Trash2 />
              Remove
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <TokenFormDialog mode="add" open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}
