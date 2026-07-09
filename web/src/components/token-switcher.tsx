import { useState } from "react";
import { Check, ChevronsUpDown, KeyRound, Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { TokenAuthModal } from "#/features/token/auth-modal/token-auth-modal.tsx";
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
import { useTokenAuthModalStore } from "#/features/token/auth-modal/token-auth-modal.store.ts";
import { useTokenFormStore } from "#/features/token/form/token-form.store.ts";
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
  const initTokenForm = useTokenFormStore((state) => state.initForm);
  const openTokenAuthModal = useTokenAuthModalStore((state) => state.openModal);

  const [removeProfileId, setRemoveProfileId] = useState<string | null>(null);
  const [removeProfileOpen, setRemoveProfileOpen] = useState(false);
  const removeProfileTarget = profiles.find((profile) => profile.id === removeProfileId) ?? null;

  function handleSwitch(profileId: string) {
    if (profileId === activeProfile?.id) {
      return;
    }

    setActiveProfile(profileId);
  }

  function handleRemove() {
    if (!removeProfileTarget) {
      return;
    }

    removeProfile(removeProfileTarget.id);
    setRemoveProfileOpen(false);
  }

  function openRemoveProfile(profileId: string) {
    setRemoveProfileId(profileId);
    setRemoveProfileOpen(true);
  }

  const triggerLabel = activeProfile ? profileDisplayName(activeProfile) : "No token";

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
              disabled={bootstrapping}
            />
          }
        >
          <KeyRound data-icon="inline-start" />
          <span data-sidebar-collapse-label className="min-w-0 flex-1 truncate text-left">
            {triggerLabel}
          </span>
          <ChevronsUpDown
            data-icon="inline-end"
            data-sidebar-collapse-label
            className="opacity-60"
          />
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
          <DropdownMenuItem
            onClick={() => {
              initTokenForm("add");
              openTokenAuthModal();
            }}
          >
            <Plus />
            Add token
          </DropdownMenuItem>
          {activeProfile ? (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => openRemoveProfile(activeProfile.id)}
            >
              <Trash2 />
              Remove
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <TokenAuthModal />
      {removeProfileTarget ? (
        <ConfirmDialog
          open={removeProfileOpen}
          title="Remove token"
          description={`Remove ${profileDisplayName(removeProfileTarget)} from this browser?`}
          confirmLabel="Remove"
          variant="destructive"
          onOpenChange={setRemoveProfileOpen}
          onConfirm={handleRemove}
        />
      ) : null}
    </>
  );
}
