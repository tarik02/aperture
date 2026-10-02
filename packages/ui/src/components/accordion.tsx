import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { cn } from "../utils.ts";

function Accordion({ className, ...props }: AccordionPrimitive.Root.Props) {
  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      className={cn("aperture:flex aperture:w-full aperture:flex-col", className)}
      {...props}
    />
  );
}

function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("aperture:not-last:border-b", className)}
      {...props}
    />
  );
}

function AccordionTrigger({ className, children, ...props }: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header className="aperture:flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "aperture:group/accordion-trigger aperture:relative aperture:flex aperture:flex-1 aperture:items-start aperture:justify-between aperture:rounded-lg aperture:border aperture:border-transparent aperture:py-2.5 aperture:text-left aperture:text-sm aperture:font-medium aperture:transition-all aperture:outline-none aperture:hover:underline aperture:focus-visible:border-ring aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:focus-visible:after:border-ring aperture:aria-disabled:pointer-events-none aperture:aria-disabled:opacity-50 aperture:**:data-[slot=accordion-trigger-icon]:ml-auto aperture:**:data-[slot=accordion-trigger-icon]:size-4 aperture:**:data-[slot=accordion-trigger-icon]:text-muted-foreground",
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon
          data-slot="accordion-trigger-icon"
          className="aperture:pointer-events-none aperture:shrink-0 aperture:group-aria-expanded/accordion-trigger:hidden"
        />
        <ChevronUpIcon
          data-slot="accordion-trigger-icon"
          className="aperture:pointer-events-none aperture:hidden aperture:shrink-0 aperture:group-aria-expanded/accordion-trigger:inline"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({ className, children, ...props }: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="aperture:overflow-hidden aperture:text-sm aperture:data-closed:animate-accordion-up aperture:data-open:animate-accordion-down"
      {...props}
    >
      <div
        className={cn(
          "aperture:h-(--accordion-panel-height) aperture:pt-0 aperture:pb-2.5 aperture:data-ending-style:h-0 aperture:data-starting-style:h-0 aperture:[&_a]:underline aperture:[&_a]:underline-offset-3 aperture:[&_a]:hover:text-foreground aperture:[&_p:not(:last-child)]:mb-4",
          className,
        )}
      >
        {children}
      </div>
    </AccordionPrimitive.Panel>
  );
}

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
