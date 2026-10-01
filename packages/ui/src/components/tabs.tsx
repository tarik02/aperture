"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../utils.ts";

function Tabs({ className, orientation = "horizontal", ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      orientation={orientation}
      className={cn(
        "aperture:group/tabs aperture:flex aperture:gap-2 aperture:data-horizontal:flex-col",
        className,
      )}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "aperture:group/tabs-list aperture:inline-flex aperture:w-fit aperture:items-center aperture:justify-center aperture:rounded-lg aperture:p-[3px] aperture:text-muted-foreground aperture:group-data-horizontal/tabs:h-8 aperture:group-data-vertical/tabs:h-fit aperture:group-data-vertical/tabs:flex-col aperture:data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "aperture:bg-muted",
        line: "aperture:gap-1 aperture:bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "aperture:relative aperture:inline-flex aperture:h-[calc(100%-1px)] aperture:flex-1 aperture:items-center aperture:justify-center aperture:gap-1.5 aperture:rounded-md aperture:border aperture:border-transparent aperture:px-1.5 aperture:py-0.5 aperture:text-sm aperture:font-medium aperture:whitespace-nowrap aperture:text-foreground/60 aperture:transition-all aperture:group-data-vertical/tabs:w-full aperture:group-data-vertical/tabs:justify-start aperture:hover:text-foreground aperture:focus-visible:border-ring aperture:focus-visible:ring-[3px] aperture:focus-visible:ring-ring/50 aperture:focus-visible:outline-1 aperture:focus-visible:outline-ring aperture:disabled:pointer-events-none aperture:disabled:opacity-50 aperture:has-data-[icon=inline-end]:pr-1 aperture:has-data-[icon=inline-start]:pl-1 aperture:aria-disabled:pointer-events-none aperture:aria-disabled:opacity-50 aperture:dark:text-muted-foreground aperture:dark:hover:text-foreground aperture:group-data-[variant=default]/tabs-list:data-active:shadow-sm aperture:group-data-[variant=line]/tabs-list:data-active:shadow-none aperture:[&_svg]:pointer-events-none aperture:[&_svg]:shrink-0 aperture:[&_svg:not([class*='size-'])]:size-4",
        "aperture:group-data-[variant=line]/tabs-list:bg-transparent aperture:group-data-[variant=line]/tabs-list:data-active:bg-transparent aperture:dark:group-data-[variant=line]/tabs-list:data-active:border-transparent aperture:dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "aperture:data-active:bg-background aperture:data-active:text-foreground aperture:dark:data-active:border-input aperture:dark:data-active:bg-input/30 aperture:dark:data-active:text-foreground",
        "aperture:after:absolute aperture:after:bg-foreground aperture:after:opacity-0 aperture:after:transition-opacity aperture:group-data-horizontal/tabs:after:inset-x-0 aperture:group-data-horizontal/tabs:after:bottom-[-5px] aperture:group-data-horizontal/tabs:after:h-0.5 aperture:group-data-vertical/tabs:after:inset-y-0 aperture:group-data-vertical/tabs:after:-right-1 aperture:group-data-vertical/tabs:after:w-0.5 aperture:group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("aperture:flex-1 aperture:text-sm aperture:outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
