import { Skeleton } from "@aperture-browser/ui/components/skeleton";
import { Spinner } from "@aperture-browser/ui/components/spinner";
import { SESSION_PICTURE } from "#/lib/view-transition.ts";

type WorkbenchSkeletonProps = {
  /** What the wait is for, said under the spinner. */
  children?: React.ReactNode;
  /** A picture of what the session showed last, to stand behind the wait. */
  picture?: string | undefined;
  note?: string;
};

/**
 * The workbench as it will be, before there is a session to fill it: its tabs, its
 * toolbar and its picture are where they will be, so that nothing jumps when it comes.
 */
export function WorkbenchSkeleton({ children, picture, note }: WorkbenchSkeletonProps) {
  return (
    <main
      data-console-session-note={note ?? "loading"}
      aria-busy
      className="aperture:flex aperture:min-h-0 aperture:flex-1 aperture:flex-col aperture:bg-background"
    >
      <div className="aperture:flex aperture:h-8 aperture:shrink-0 aperture:items-center aperture:gap-2 aperture:bg-muted/40 aperture:px-2">
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
        {picture === undefined ? null : (
          <img
            alt=""
            aria-hidden
            src={picture}
            // One that has no picture shows none.
            onError={(event) => event.currentTarget.remove()}
            className="aperture:absolute aperture:inset-0 aperture:size-full aperture:scale-105 aperture:object-cover aperture:object-top aperture:opacity-60 aperture:blur-md"
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
