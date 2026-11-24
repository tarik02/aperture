"use client";

import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { ChevronDownIcon, XIcon } from "lucide-react";

import { useKeyboardCovered } from "../keyboard-inset.ts";
import { cn } from "../utils.ts";
import { ComboboxContent, ComboboxInput } from "./combobox.tsx";

/**
 * The field of a combobox that several things are chosen in, where nothing is typed into
 * the field itself: it shows what is chosen, and pressed, it opens a list that has what is
 * typed at its top. It is as tall as what is chosen, up to three lines, and scrolls once
 * there is more.
 */
function PickerTrigger({
  anchor,
  invalid = false,
  disabled = false,
  placeholder,
  className,
  children,
  ...props
}: Omit<ComboboxPrimitive.Trigger.Props, "children"> & {
  /** What the list opens below: the field. */
  anchor: React.Ref<HTMLDivElement>;
  invalid?: boolean;
  /** What it says while nothing is chosen. */
  placeholder?: React.ReactNode;
  /** What is chosen: chips, and none where nothing is. */
  children?: ReadonlyArray<React.ReactNode>;
}) {
  return (
    <ComboboxPrimitive.Trigger
      // What is chosen is given up by buttons within it, which a button does not hold.
      nativeButton={false}
      render={<div ref={anchor} />}
      aria-invalid={invalid || undefined}
      data-slot="picker"
      className={cn(
        "aperture:flex aperture:min-h-8 aperture:w-full aperture:cursor-default aperture:items-start aperture:gap-1 aperture:rounded-lg aperture:border aperture:border-input aperture:bg-transparent aperture:bg-clip-padding aperture:p-1 aperture:text-sm aperture:transition-colors aperture:outline-none aperture:select-none aperture:focus-visible:border-ring aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:data-popup-open:border-ring aperture:data-popup-open:ring-3 aperture:data-popup-open:ring-ring/50 aperture:aria-invalid:border-destructive aperture:aria-invalid:ring-3 aperture:aria-invalid:ring-destructive/20 aperture:dark:bg-input/30 aperture:dark:aria-invalid:border-destructive/50 aperture:dark:aria-invalid:ring-destructive/40 aperture:pointer-coarse:min-h-12",
        // Up to three lines of what is chosen, of the height those have where a finger presses.
        "aperture:max-h-20 aperture:overflow-x-hidden aperture:overflow-y-auto aperture:overscroll-contain aperture:[scrollbar-width:thin] aperture:pointer-coarse:max-h-[8.75rem]",
        disabled && "aperture:pointer-events-none aperture:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-wrap aperture:content-start aperture:items-center aperture:gap-1">
        {children === undefined || children.length === 0 ? (
          <span className="aperture:flex aperture:h-[calc(--spacing(5.25))] aperture:items-center aperture:px-1.5 aperture:text-muted-foreground aperture:pointer-coarse:h-10">
            {placeholder}
          </span>
        ) : (
          children
        )}
      </span>
      <ChevronDownIcon
        aria-hidden
        className="aperture:pointer-events-none aperture:sticky aperture:top-0 aperture:mx-1 aperture:size-4 aperture:h-[calc(--spacing(5.25))] aperture:shrink-0 aperture:text-muted-foreground aperture:pointer-coarse:h-10"
      />
    </ComboboxPrimitive.Trigger>
  );
}

/** One thing that is chosen, in the field: given up by its button, where it has one. */
function PickerChip({
  onRemove,
  removeLabel,
  disabled = false,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & {
  /** Gives it up; what is always chosen has none. */
  onRemove?: (() => void) | undefined;
  removeLabel?: string;
  disabled?: boolean;
}) {
  return (
    <span
      data-slot="picker-chip"
      className={cn(
        "aperture:flex aperture:h-[calc(--spacing(5.25))] aperture:max-w-full aperture:items-center aperture:gap-1 aperture:rounded-sm aperture:bg-muted aperture:pl-1.5 aperture:text-xs aperture:font-medium aperture:text-foreground aperture:pointer-coarse:h-10 aperture:pointer-coarse:pl-2.5",
        onRemove === undefined && "aperture:pr-1.5 aperture:pointer-coarse:pr-2.5",
        className,
      )}
      {...props}
    >
      <span className="aperture:truncate">{children}</span>
      {onRemove === undefined ? null : (
        <button
          type="button"
          data-slot="picker-chip-remove"
          aria-label={removeLabel}
          disabled={disabled}
          className="aperture:-ml-1 aperture:flex aperture:h-full aperture:w-5 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-sm aperture:opacity-50 aperture:outline-none aperture:hover:opacity-100 aperture:focus-visible:opacity-100 aperture:focus-visible:ring-2 aperture:focus-visible:ring-ring/50 aperture:pointer-coarse:w-8"
          // Giving one up is not pressing the field: the list stays as it is.
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <XIcon className="aperture:pointer-events-none aperture:size-3" />
        </button>
      )}
    </span>
  );
}

/** The list a picker opens, with what is typed at its top. */
function PickerContent(props: React.ComponentProps<typeof ComboboxContent>) {
  const covered = useKeyboardCovered();
  return (
    <ComboboxContent
      // Clear of what an on-screen keyboard covers: the list is typed into.
      collisionPadding={{ top: 8 + covered.top, bottom: 8 + covered.bottom, left: 8, right: 8 }}
      {...props}
    />
  );
}

/** What is typed in a picker's list, to find among what it offers. */
function PickerSearch({ className, ...props }: React.ComponentProps<typeof ComboboxInput>) {
  return (
    <ComboboxInput
      showTrigger={false}
      autoCapitalize="none"
      autoComplete="off"
      spellCheck={false}
      className={cn("aperture:pointer-coarse:h-10!", className)}
      {...props}
    />
  );
}

export { PickerTrigger, PickerChip, PickerContent, PickerSearch };
