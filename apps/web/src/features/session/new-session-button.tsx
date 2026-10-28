import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Layers, Plus, SearchIcon, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { flattenInfinitePages } from "@aperture-browser/api-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { useBrowserChannelsQuery } from "#/features/browser/browser.queries.ts";
import type { SessionCreateRequest } from "#/features/session/create-dialog/session-create-dialog.tsx";
import { useCreateSessionMutation } from "#/features/session/session.mutations.ts";
import { useSnapshotsInfiniteQuery } from "#/features/snapshot/snapshot.queries.ts";

/**
 * Starts a session right away in the first browser channel, without a snapshot. The split menu
 * starts one from a snapshot instead, or opens the full form.
 */
export function NewSessionButton({
  onCustom,
}: {
  onCustom: (request?: SessionCreateRequest) => void;
}) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const channelsQuery = useBrowserChannelsQuery();
  const snapshotsQuery = useSnapshotsInfiniteQuery({ limit: 100 }, { enabled: menuOpen });
  const mutation = useCreateSessionMutation();
  const snapshots = useMemo(
    () => flattenInfinitePages(snapshotsQuery.data?.pages),
    [snapshotsQuery.data?.pages],
  );
  const channel = channelsQuery.data?.channels[0]?.name;

  function start(baseSnapshotName: string | null) {
    if (!channel) {
      // Channels haven't loaded or none exist; the form explains which.
      onCustom(baseSnapshotName ? { baseSnapshot: baseSnapshotName } : undefined);
      return;
    }
    mutation.mutate(
      { label: null, browser: { channel, args: [] }, baseSnapshotName, tags: {} },
      {
        onSuccess: (result) =>
          void navigate({ to: "/-/sessions/$sessionId", params: { sessionId: result.session.id } }),
      },
    );
  }

  return (
    <div className="aperture:flex aperture:shrink-0">
      <Button
        className="aperture:rounded-r-none"
        disabled={mutation.isPending}
        title="New session"
        aria-label="New session"
        onClick={() => start(null)}
      >
        {mutation.isPending ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <Plus data-icon="inline-start" />
        )}
        <span className="aperture:max-md:sr-only">New session</span>
      </Button>
      <MenuPrimitive.FilterProvider autoHighlight filter={keepCustom}>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            openOnHover
            delay={150}
            render={
              <Button
                className="aperture:rounded-l-none aperture:border-l aperture:border-l-primary-foreground/20 aperture:px-2"
                disabled={mutation.isPending}
                aria-label="More ways to start a session"
              />
            }
          >
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="aperture:w-auto aperture:p-0">
            <div className="aperture:grid aperture:w-80 aperture:max-w-[calc(100vw-2rem)]">
              <div className="aperture:flex aperture:h-9 aperture:items-center aperture:gap-2 aperture:border-b aperture:px-2">
                <SearchIcon className="aperture:size-4 aperture:text-muted-foreground" />
                <MenuPrimitive.Input
                  placeholder="Start from a snapshot"
                  aria-label="Search snapshots"
                  className="aperture:h-full aperture:min-w-0 aperture:flex-1 aperture:bg-transparent aperture:text-sm aperture:outline-none"
                />
              </div>
              <MenuPrimitive.List className="aperture:max-h-72 aperture:overflow-y-auto aperture:p-1">
                {snapshots.map((snapshot) => (
                  <DropdownMenuItem
                    key={snapshot.name}
                    label={`${snapshot.name} ${snapshot.description ?? ""}`}
                    onClick={() => start(snapshot.name)}
                  >
                    <Layers />
                    <span className="aperture:grid aperture:min-w-0 aperture:flex-1">
                      <span className="aperture:truncate">{snapshot.name}</span>
                      {snapshot.description ? (
                        <span className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
                          {snapshot.description}
                        </span>
                      ) : null}
                    </span>
                  </DropdownMenuItem>
                ))}
              </MenuPrimitive.List>
              <MenuPrimitive.Empty className="aperture:px-3 aperture:py-6 aperture:text-center aperture:text-sm aperture:text-muted-foreground aperture:empty:hidden">
                {snapshotsQuery.isPending
                  ? "Loading snapshots…"
                  : snapshots.length === 0
                    ? "No snapshots yet."
                    : "No snapshots match."}
              </MenuPrimitive.Empty>
              <DropdownMenuSeparator className="aperture:my-0" />
              <div className="aperture:p-1">
                <DropdownMenuItem label={customLabel} onClick={() => onCustom()}>
                  <SlidersHorizontal />
                  Custom…
                </DropdownMenuItem>
              </div>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </MenuPrimitive.FilterProvider>
    </div>
  );
}

const customLabel = "Custom…";

// The search narrows the snapshots; the way to the full form stays.
function keepCustom(text: string, query: string) {
  return text === customLabel || text.toLowerCase().includes(query.toLowerCase());
}
