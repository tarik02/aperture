import { cn } from "@aperture-browser/ui/utils";
import { SidebarTrigger } from "@aperture-browser/ui/components/sidebar";
import { Skeleton } from "@aperture-browser/ui/components/skeleton";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { useState } from "react";
import { SESSION_PICTURE } from "#/lib/view-transition.ts";

type WorkbenchSkeletonProps = {
  /** What the wait is for, said under the spinner. */
  children?: React.ReactNode;
  /** A picture of what the session showed last, to stand behind the wait. */
  picture?: string | undefined;
  note?: string;
  /** Whether it lies over a workbench that is not drawn yet, in place of standing for one. */
  over?: boolean;
};

/**
 * The workbench as it will be, before there is a session to fill it: its tabs, its
 * toolbar and its picture are where they will be, so that nothing jumps when it comes.
 */
export function WorkbenchSkeleton({
  children,
  picture,
  note,
  over = false,
}: WorkbenchSkeletonProps) {
  // Which address gave no picture: another one is tried anew.
  const [missing, setMissing] = useState<string>();
  return (
    <main
      data-console-session-note={note ?? "loading"}
      aria-busy
      className={cn(
        "aperture:flex aperture:min-h-0 aperture:flex-1 aperture:flex-col aperture:bg-background",
        // Over the workbench that is filling in below it.
        over && "aperture:pointer-events-none aperture:absolute aperture:inset-0 aperture:z-30",
      )}
    >
      <div
        data-workbench-titlebar-skeleton=""
        className="aperture:flex aperture:h-8 aperture:shrink-0 aperture:items-center aperture:gap-2 aperture:bg-muted/40 aperture:px-2"
      >
        {/* The way to the sidebar is where the workbench has it, and works before there is one. */}
        <SidebarTrigger
          data-console-sidebar-trigger
          className="aperture:pointer-events-auto aperture:-ml-2 aperture:aspect-square aperture:h-full aperture:w-auto aperture:shrink-0 aperture:rounded-none"
        />
        <Skeleton className="aperture:h-5 aperture:w-44 aperture:rounded-md" />
        <Skeleton className="aperture:size-5 aperture:rounded-md" />
        <span className="aperture:flex-1" />
        <Skeleton className="aperture:size-5 aperture:rounded-full" />
      </div>
      <div className="aperture:flex aperture:h-9 aperture:shrink-0 aperture:items-center aperture:gap-2 aperture:border-b aperture:px-2">
        <Skeleton className="aperture:size-5 aperture:rounded-md" />
        <Skeleton className="aperture:size-5 aperture:rounded-md" />
        <Skeleton className="aperture:size-5 aperture:rounded-md" />
        <Skeleton className="aperture:h-6 aperture:flex-1 aperture:rounded-md" />
        <Skeleton className="aperture:size-5 aperture:rounded-md" />
        <Skeleton className="aperture:size-5 aperture:rounded-md" />
        <Skeleton className="aperture:size-5 aperture:rounded-md" />
      </div>
      <div
        className="aperture:relative aperture:min-h-0 aperture:flex-1 aperture:overflow-hidden aperture:bg-muted/30"
        style={{ viewTransitionName: SESSION_PICTURE }}
      >
        {picture === undefined || missing === picture ? null : (
          <img
            alt=""
            aria-hidden
            src={picture}
            // One that has no picture shows none.
            onError={() => setMissing(picture)}
            className="aperture:absolute aperture:inset-0 aperture:size-full aperture:scale-105 aperture:object-cover aperture:object-top aperture:blur-md"
          />
        )}
        <div className="aperture:absolute aperture:inset-0 aperture:flex aperture:flex-col aperture:items-center aperture:justify-center aperture:gap-2 aperture:text-sm aperture:text-muted-foreground">
          <Spinner />
          {children}
        </div>
      </div>
    </main>
  );
}
