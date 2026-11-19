import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "../utils.ts";

function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "aperture:flex aperture:h-full aperture:w-full aperture:aria-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "aperture:relative aperture:flex aperture:w-px aperture:items-center aperture:justify-center aperture:bg-border aperture:ring-offset-background aperture:after:absolute aperture:after:inset-y-0 aperture:after:left-1/2 aperture:after:w-1 aperture:after:-translate-x-1/2 aperture:focus-visible:ring-1 aperture:focus-visible:ring-ring aperture:focus-visible:outline-hidden aperture:aria-[orientation=horizontal]:h-px aperture:aria-[orientation=horizontal]:w-full aperture:aria-[orientation=horizontal]:after:left-0 aperture:aria-[orientation=horizontal]:after:h-1 aperture:aria-[orientation=horizontal]:after:w-full aperture:aria-[orientation=horizontal]:after:translate-x-0 aperture:aria-[orientation=horizontal]:after:-translate-y-1/2 aperture:[&[aria-orientation=horizontal]>div]:rotate-90",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="aperture:z-10 aperture:flex aperture:h-6 aperture:w-1 aperture:shrink-0 aperture:rounded-lg aperture:bg-border" />
      )}
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
