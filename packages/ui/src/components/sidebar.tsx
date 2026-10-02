"use client";

import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { SidebarProvider, useSidebar } from "./sidebar-provider.tsx";
import { cn } from "../utils.ts";
import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { ScrollArea } from "./scroll-area.tsx";
import { Separator } from "./separator.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./sheet.tsx";
import { Skeleton } from "./skeleton.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip.tsx";
import { PanelLeftIcon } from "lucide-react";

const SIDEBAR_WIDTH_MOBILE = "min(15rem, 85vw)";

function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  className,
  children,
  dir,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

  if (collapsible === "none") {
    return (
      <div
        data-slot="sidebar"
        className={cn(
          "aperture:flex aperture:h-full aperture:w-(--sidebar-width) aperture:flex-col aperture:bg-sidebar aperture:text-sidebar-foreground",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  }

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
        <SheetContent
          dir={dir}
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          className="aperture:w-(--sidebar-width) aperture:bg-sidebar aperture:p-0 aperture:text-sidebar-foreground aperture:[&>button]:hidden"
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
            } as React.CSSProperties
          }
          side={side}
        >
          <SheetHeader className="aperture:sr-only">
            <SheetTitle>Sidebar</SheetTitle>
            <SheetDescription>Displays the mobile sidebar.</SheetDescription>
          </SheetHeader>
          <div className="aperture:flex aperture:h-full aperture:w-full aperture:flex-col">
            {children}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className="aperture:group aperture:peer aperture:hidden aperture:text-sidebar-foreground aperture:md:block"
      data-state={state}
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          "aperture:relative aperture:w-(--sidebar-width) aperture:bg-transparent aperture:transition-[width] aperture:duration-200 aperture:ease-out",
          "aperture:group-data-[collapsible=offcanvas]:w-0",
          "aperture:group-data-[side=right]:rotate-180",
          variant === "floating" || variant === "inset"
            ? "aperture:group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
            : "aperture:group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
        )}
      />
      <div
        data-slot="sidebar-container"
        data-side={side}
        className={cn(
          "aperture:fixed aperture:inset-y-0 aperture:z-10 aperture:hidden aperture:h-svh aperture:w-(--sidebar-width) aperture:transition-[left,right,width] aperture:duration-200 aperture:ease-out aperture:data-[side=left]:left-0 aperture:data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] aperture:data-[side=right]:right-0 aperture:data-[side=right]:group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)] aperture:md:flex",
          // Adjust the padding for floating and inset variants.
          variant === "floating" || variant === "inset"
            ? "aperture:p-2 aperture:group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
            : "aperture:group-data-[collapsible=icon]:w-(--sidebar-width-icon) aperture:group-data-[side=left]:border-r aperture:group-data-[side=right]:border-l",
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="aperture:flex aperture:size-full aperture:flex-col aperture:bg-sidebar aperture:group-data-[variant=floating]:rounded-lg aperture:group-data-[variant=floating]:shadow-sm aperture:group-data-[variant=floating]:ring-1 aperture:group-data-[variant=floating]:ring-sidebar-border"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      className={cn(className)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      <PanelLeftIcon />
      <span className="aperture:sr-only">Toggle Sidebar</span>
    </Button>
  );
}

function SidebarRail({ className, ...props }: React.ComponentProps<"button">) {
  const { toggleSidebar } = useSidebar();

  return (
    <button
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle Sidebar"
      className={cn(
        "aperture:absolute aperture:inset-y-0 aperture:z-20 aperture:hidden aperture:w-4 aperture:transition-all aperture:ease-linear aperture:group-data-[side=left]:-right-4 aperture:group-data-[side=right]:left-0 aperture:after:absolute aperture:after:inset-y-0 aperture:after:start-1/2 aperture:after:w-[2px] aperture:hover:after:bg-sidebar-border aperture:sm:flex aperture:ltr:-translate-x-1/2 aperture:rtl:-translate-x-1/2",
        "aperture:in-data-[side=left]:cursor-w-resize aperture:in-data-[side=right]:cursor-e-resize",
        "aperture:[[data-side=left][data-state=collapsed]_&]:cursor-e-resize aperture:[[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
        "aperture:group-data-[collapsible=offcanvas]:translate-x-0 aperture:group-data-[collapsible=offcanvas]:after:left-full aperture:hover:group-data-[collapsible=offcanvas]:bg-sidebar",
        "aperture:[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
        "aperture:[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
        className,
      )}
      {...props}
    />
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        "aperture:relative aperture:flex aperture:w-full aperture:flex-1 aperture:flex-col aperture:bg-background aperture:md:peer-data-[variant=inset]:m-2 aperture:md:peer-data-[variant=inset]:ml-0 aperture:md:peer-data-[variant=inset]:rounded-xl aperture:md:peer-data-[variant=inset]:shadow-sm aperture:md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2",
        className,
      )}
      {...props}
    />
  );
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="sidebar-input"
      data-sidebar="input"
      className={cn(
        "aperture:h-8 aperture:w-full aperture:bg-background aperture:shadow-none",
        className,
      )}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn("aperture:flex aperture:flex-col aperture:gap-2 aperture:p-2", className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn("aperture:flex aperture:flex-col aperture:gap-2 aperture:p-2", className)}
      {...props}
    />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn("aperture:mx-2 aperture:w-auto aperture:bg-sidebar-border", className)}
      {...props}
    />
  );
}

function SidebarContent({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <ScrollArea
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn("aperture:min-h-0 aperture:flex-1", className)}
      viewportClassName="aperture:h-full"
      {...props}
    >
      <div className="aperture:flex aperture:min-h-full aperture:flex-col aperture:gap-0">
        {children}
      </div>
    </ScrollArea>
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn(
        "aperture:relative aperture:flex aperture:w-full aperture:min-w-0 aperture:flex-col aperture:p-2",
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroupLabel({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div"> & React.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "aperture:flex aperture:h-8 aperture:shrink-0 aperture:items-center aperture:rounded-md aperture:px-2 aperture:text-xs aperture:font-medium aperture:text-sidebar-foreground/70 aperture:ring-sidebar-ring aperture:outline-hidden aperture:transition-[margin,opacity] aperture:duration-200 aperture:ease-linear aperture:group-data-[collapsible=icon]:-mt-8 aperture:group-data-[collapsible=icon]:opacity-0 aperture:focus-visible:ring-2 aperture:[&>svg]:size-4 aperture:[&>svg]:shrink-0",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "sidebar-group-label",
      sidebar: "group-label",
    },
  });
}

function SidebarGroupAction({
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> & React.ComponentProps<"button">) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(
          "aperture:absolute aperture:top-3.5 aperture:right-3 aperture:flex aperture:aspect-square aperture:w-5 aperture:items-center aperture:justify-center aperture:rounded-md aperture:p-0 aperture:text-sidebar-foreground aperture:ring-sidebar-ring aperture:outline-hidden aperture:transition-transform aperture:group-data-[collapsible=icon]:hidden aperture:after:absolute aperture:after:-inset-2 aperture:hover:bg-sidebar-accent aperture:hover:text-sidebar-accent-foreground aperture:focus-visible:ring-2 aperture:md:after:hidden aperture:[&>svg]:size-4 aperture:[&>svg]:shrink-0",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "sidebar-group-action",
      sidebar: "group-action",
    },
  });
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn("aperture:w-full aperture:text-sm", className)}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn(
        "aperture:flex aperture:w-full aperture:min-w-0 aperture:flex-col aperture:gap-0",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("aperture:group/menu-item aperture:relative", className)}
      {...props}
    />
  );
}

const sidebarMenuButtonVariants = cva(
  "aperture:peer/menu-button aperture:group/menu-button aperture:flex aperture:w-full aperture:items-center aperture:gap-2 aperture:overflow-hidden aperture:rounded-md aperture:p-2 aperture:text-left aperture:text-sm aperture:ring-sidebar-ring aperture:outline-hidden aperture:transition-[width,height,padding,gap,background-color,color] aperture:duration-200 aperture:ease-out aperture:group-has-data-[sidebar=menu-action]/menu-item:pr-8 aperture:group-data-[collapsible=icon]:w-8! aperture:group-data-[collapsible=icon]:gap-0! aperture:group-data-[collapsible=icon]:pr-0! aperture:hover:bg-sidebar-accent/60 aperture:hover:text-sidebar-accent-foreground aperture:focus-visible:ring-2 aperture:active:bg-sidebar-accent/70 aperture:active:text-sidebar-accent-foreground aperture:disabled:pointer-events-none aperture:disabled:opacity-50 aperture:aria-disabled:pointer-events-none aperture:aria-disabled:opacity-50 aperture:data-open:hover:bg-sidebar-accent/60 aperture:data-open:text-sidebar-accent-foreground aperture:data-open:hover:text-sidebar-accent-foreground aperture:data-active:bg-sidebar-accent/70 aperture:data-active:font-medium aperture:data-active:text-sidebar-accent-foreground aperture:[&_svg]:size-4 aperture:[&_svg]:shrink-0 aperture:[&>span:last-child]:truncate",
  {
    variants: {
      variant: {
        default:
          "aperture:hover:bg-sidebar-accent/60 aperture:hover:text-sidebar-accent-foreground",
        outline:
          "aperture:bg-background aperture:shadow-[0_0_0_1px_var(--sidebar-border)] aperture:hover:bg-sidebar-accent/60 aperture:hover:text-sidebar-accent-foreground aperture:hover:shadow-[0_0_0_1px_var(--sidebar-accent)]",
      },
      size: {
        default: "aperture:h-8 aperture:text-sm",
        sm: "aperture:h-7 aperture:text-xs",
        lg: "aperture:h-12 aperture:text-sm aperture:group-data-[collapsible=icon]:p-0!",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function SidebarMenuButton({
  render,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  ...props
}: useRender.ComponentProps<"button"> &
  React.ComponentProps<"button"> & {
    isActive?: boolean;
    tooltip?: string | React.ComponentProps<typeof TooltipContent>;
  } & VariantProps<typeof sidebarMenuButtonVariants>) {
  const { isMobile, state } = useSidebar();
  const comp = useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(sidebarMenuButtonVariants({ variant, size }), className),
      },
      props,
    ),
    render: !tooltip ? render : <TooltipTrigger render={render} />,
    state: {
      slot: "sidebar-menu-button",
      sidebar: "menu-button",
      size,
      active: isActive,
    },
  });

  if (!tooltip) {
    return comp;
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    };
  }

  return (
    <Tooltip>
      {comp}
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== "collapsed" || isMobile}
        {...tooltip}
      />
    </Tooltip>
  );
}

function SidebarMenuAction({
  className,
  render,
  showOnHover = false,
  ...props
}: useRender.ComponentProps<"button"> &
  React.ComponentProps<"button"> & {
    showOnHover?: boolean;
  }) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        className: cn(
          "aperture:absolute aperture:top-1.5 aperture:right-1 aperture:flex aperture:aspect-square aperture:w-5 aperture:items-center aperture:justify-center aperture:rounded-md aperture:p-0 aperture:text-sidebar-foreground aperture:ring-sidebar-ring aperture:outline-hidden aperture:transition-transform aperture:group-data-[collapsible=icon]:hidden aperture:peer-hover/menu-button:text-sidebar-accent-foreground aperture:peer-data-[size=default]/menu-button:top-1.5 aperture:peer-data-[size=lg]/menu-button:top-2.5 aperture:peer-data-[size=sm]/menu-button:top-1 aperture:after:absolute aperture:after:-inset-2 aperture:hover:bg-sidebar-accent aperture:hover:text-sidebar-accent-foreground aperture:focus-visible:ring-2 aperture:md:after:hidden aperture:[&>svg]:size-4 aperture:[&>svg]:shrink-0",
          showOnHover &&
            "aperture:group-focus-within/menu-item:opacity-100 aperture:group-hover/menu-item:opacity-100 aperture:peer-data-active/menu-button:text-sidebar-accent-foreground aperture:aria-expanded:opacity-100 aperture:md:opacity-0",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "sidebar-menu-action",
      sidebar: "menu-action",
    },
  });
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        "aperture:pointer-events-none aperture:absolute aperture:right-1 aperture:flex aperture:h-5 aperture:min-w-5 aperture:items-center aperture:justify-center aperture:rounded-md aperture:px-1 aperture:text-xs aperture:font-medium aperture:text-sidebar-foreground aperture:tabular-nums aperture:select-none aperture:group-data-[collapsible=icon]:hidden aperture:peer-hover/menu-button:text-sidebar-accent-foreground aperture:peer-data-[size=default]/menu-button:top-1.5 aperture:peer-data-[size=lg]/menu-button:top-2.5 aperture:peer-data-[size=sm]/menu-button:top-1 aperture:peer-data-active/menu-button:text-sidebar-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<"div"> & {
  showIcon?: boolean;
}) {
  // Random width between 50 to 90%.
  const [width] = React.useState(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`;
  });

  return (
    <div
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn(
        "aperture:flex aperture:h-8 aperture:items-center aperture:gap-2 aperture:rounded-md aperture:px-2",
        className,
      )}
      {...props}
    >
      {showIcon && (
        <Skeleton
          className="aperture:size-4 aperture:rounded-md"
          data-sidebar="menu-skeleton-icon"
        />
      )}
      <Skeleton
        className="aperture:h-4 aperture:max-w-(--skeleton-width) aperture:flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            "--skeleton-width": width,
          } as React.CSSProperties
        }
      />
    </div>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        "aperture:mx-3.5 aperture:flex aperture:min-w-0 aperture:translate-x-px aperture:flex-col aperture:gap-1 aperture:border-l aperture:border-sidebar-border aperture:px-2.5 aperture:py-0.5 aperture:group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn("aperture:group/menu-sub-item aperture:relative", className)}
      {...props}
    />
  );
}

function SidebarMenuSubButton({
  render,
  size = "md",
  isActive = false,
  className,
  ...props
}: useRender.ComponentProps<"a"> &
  React.ComponentProps<"a"> & {
    size?: "sm" | "md";
    isActive?: boolean;
  }) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        className: cn(
          "aperture:flex aperture:h-7 aperture:min-w-0 aperture:-translate-x-px aperture:items-center aperture:gap-2 aperture:overflow-hidden aperture:rounded-md aperture:px-2 aperture:text-sidebar-foreground aperture:ring-sidebar-ring aperture:outline-hidden aperture:group-data-[collapsible=icon]:hidden aperture:hover:bg-sidebar-accent aperture:hover:text-sidebar-accent-foreground aperture:focus-visible:ring-2 aperture:active:bg-sidebar-accent aperture:active:text-sidebar-accent-foreground aperture:disabled:pointer-events-none aperture:disabled:opacity-50 aperture:aria-disabled:pointer-events-none aperture:aria-disabled:opacity-50 aperture:data-[size=md]:text-sm aperture:data-[size=sm]:text-xs aperture:data-active:bg-sidebar-accent aperture:data-active:text-sidebar-accent-foreground aperture:[&>span:last-child]:truncate aperture:[&>svg]:size-4 aperture:[&>svg]:shrink-0 aperture:[&>svg]:text-sidebar-accent-foreground",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "sidebar-menu-sub-button",
      sidebar: "menu-sub-button",
      size,
      active: isActive,
    },
  });
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
};
