import { cn } from "../utils.ts";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("aperture:animate-pulse aperture:rounded-md aperture:bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
