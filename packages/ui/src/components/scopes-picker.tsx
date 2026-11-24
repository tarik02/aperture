"use client";

import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { ChevronDownIcon, XIcon } from "lucide-react";

import { cn } from "../utils.ts";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "./combobox.tsx";

/** A scope as OAuth has it: a word with no space, quote or backslash in it. */
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;
const BETWEEN = /[\s,]+/u;

const isScope = (word: string) => SCOPE.test(word);

type Entry = {
  readonly value: string;
  /** Typed, and known from nowhere else: it is offered to be added. */
  readonly typed?: true;
};
type Listed = { readonly value: string; readonly items: ReadonlyArray<Entry> };

/** Scopes that are known together: by what offers them, or what they are for. */
type ScopesGroup = { readonly label: string; readonly scopes: ReadonlyArray<string> };

type ScopesPickerProps = {
  id?: string;
  value: ReadonlyArray<string>;
  onValueChange: (value: ReadonlyArray<string>) => void;
  /** The scopes that are offered. One that is in several groups is offered in the first. */
  groups: ReadonlyArray<ScopesGroup>;
  /** Those that are always asked for: they are chosen, and not given up. */
  required?: ReadonlyArray<string>;
  /** What scopes that were chosen and are offered by no group are listed under. */
  othersLabel?: string;
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
};

/** What of the window's top and foot is not seen: an on-screen keyboard, mostly. */
function useCovered() {
  const subscribe = React.useCallback((tell: () => void) => {
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", tell);
    viewport?.addEventListener("scroll", tell);
    return () => {
      viewport?.removeEventListener("resize", tell);
      viewport?.removeEventListener("scroll", tell);
    };
  }, []);
  // One string, so that what is told is the same until it changes.
  const told = React.useSyncExternalStore(
    subscribe,
    () => {
      const viewport = window.visualViewport;
      if (viewport === null || Math.abs(viewport.scale - 1) >= 0.01) {
        return "0 0";
      }
      const top = Math.max(0, Math.round(viewport.offsetTop));
      return `${top} ${Math.max(0, Math.round(window.innerHeight - viewport.height - top))}`;
    },
    () => "0 0",
  );
  const [top = 0, bottom = 0] = told.split(" ").map(Number);
  return { top, bottom };
}

/**
 * Chooses scopes. The field shows what is chosen and nothing is typed into it: pressed, it
 * opens a list with a field of its own at its top, where the known ones are sought and
 * ticked and any other is typed and added. The field is as tall as what is chosen, up to
 * three lines, and scrolls once there is more.
 */
function ScopesPicker({
  id,
  value,
  onValueChange,
  groups,
  required = [],
  othersLabel = "Added",
  invalid = false,
  disabled = false,
  placeholder,
  className,
  "aria-label": label,
}: ScopesPickerProps) {
  const anchor = React.useRef<HTMLDivElement | null>(null);
  const covered = useCovered();
  const [typed, setTyped] = React.useState("");
  const word = typed.trim();

  const seen = new Set<string>();
  const offered: Array<Listed> = [];
  for (const group of [...groups, { label: othersLabel, scopes: value }]) {
    const items = group.scopes.filter((scope) => !seen.has(scope));
    for (const scope of items) {
      seen.add(scope);
    }
    if (items.length > 0) {
      offered.push({ value: group.label, items: items.map((scope) => ({ value: scope })) });
    }
  }
  const listed: ReadonlyArray<Listed> =
    word !== "" && isScope(word) && !seen.has(word)
      ? [...offered, { value: "", items: [{ value: word, typed: true }] }]
      : offered;

  /** What is chosen from now on: what is always asked for first, and nothing twice. */
  const chosen = (scopes: ReadonlyArray<string>) =>
    onValueChange([...new Set([...required, ...scopes])]);

  return (
    <Combobox
      multiple
      autoHighlight
      disabled={disabled}
      items={listed}
      value={value.map((scope): Entry => ({ value: scope }))}
      inputValue={typed}
      itemToStringLabel={(entry: Entry) => entry.value}
      itemToStringValue={(entry: Entry) => entry.value}
      isItemEqualToValue={(one: Entry, other: Entry) => one.value === other.value}
      filter={(entry: Entry, sought: string) =>
        entry.typed === true || entry.value.toLowerCase().includes(sought.trim().toLowerCase())
      }
      onInputValueChange={(next: string) => {
        // Several at once, as they are written elsewhere: each that is whole is added.
        const words = next.split(BETWEEN);
        const rest = words.pop() ?? "";
        const whole = words.filter((one) => one !== "");
        if (whole.length > 0 && whole.every(isScope)) {
          chosen([...value, ...whole]);
          setTyped(rest);
          return;
        }
        setTyped(next);
      }}
      onValueChange={(next: Entry[], details) => {
        // Escape closes the list; it does not take back what was chosen from it.
        if (details.reason === "escape-key") {
          details.allowPropagation();
          return;
        }
        chosen(next.map((entry) => entry.value));
      }}
    >
      <ComboboxPrimitive.Trigger
        id={id}
        // What is chosen is given up by buttons within it, which a button does not hold.
        nativeButton={false}
        render={<div ref={anchor} />}
        aria-label={label}
        aria-invalid={invalid || undefined}
        data-slot="scopes-picker"
        className={cn(
          "aperture:flex aperture:min-h-8 aperture:w-full aperture:cursor-default aperture:items-start aperture:gap-1 aperture:rounded-lg aperture:border aperture:border-input aperture:bg-transparent aperture:bg-clip-padding aperture:p-1 aperture:text-sm aperture:transition-colors aperture:outline-none aperture:select-none aperture:focus-visible:border-ring aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50 aperture:data-popup-open:border-ring aperture:data-popup-open:ring-3 aperture:data-popup-open:ring-ring/50 aperture:aria-invalid:border-destructive aperture:aria-invalid:ring-3 aperture:aria-invalid:ring-destructive/20 aperture:dark:bg-input/30 aperture:dark:aria-invalid:border-destructive/50 aperture:dark:aria-invalid:ring-destructive/40 aperture:pointer-coarse:min-h-12",
          // Up to three lines of what is chosen, of the height those have where a finger presses.
          "aperture:max-h-20 aperture:overflow-x-hidden aperture:overflow-y-auto aperture:overscroll-contain aperture:[scrollbar-width:thin] aperture:pointer-coarse:max-h-[8.75rem]",
          disabled && "aperture:pointer-events-none aperture:opacity-50",
          className,
        )}
      >
        <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-wrap aperture:content-start aperture:items-center aperture:gap-1">
          {value.length === 0 ? (
            <span className="aperture:flex aperture:h-[calc(--spacing(5.25))] aperture:items-center aperture:px-1.5 aperture:text-muted-foreground aperture:pointer-coarse:h-10">
              {placeholder}
            </span>
          ) : null}
          {value.map((scope) => (
            <span
              key={scope}
              data-slot="scopes-picker-chip"
              data-scope={scope}
              title={scope}
              className={cn(
                "aperture:flex aperture:h-[calc(--spacing(5.25))] aperture:max-w-full aperture:items-center aperture:gap-1 aperture:rounded-sm aperture:bg-muted aperture:pl-1.5 aperture:font-mono aperture:text-xs aperture:font-medium aperture:text-foreground aperture:pointer-coarse:h-10 aperture:pointer-coarse:pl-2.5",
                required.includes(scope) && "aperture:pr-1.5 aperture:pointer-coarse:pr-2.5",
              )}
            >
              <span className="aperture:truncate">{scope}</span>
              {required.includes(scope) ? null : (
                <button
                  type="button"
                  data-slot="scopes-picker-chip-remove"
                  aria-label={`Remove ${scope}`}
                  disabled={disabled}
                  className="aperture:-ml-1 aperture:flex aperture:h-full aperture:w-5 aperture:shrink-0 aperture:items-center aperture:justify-center aperture:rounded-sm aperture:opacity-50 aperture:outline-none aperture:hover:opacity-100 aperture:focus-visible:opacity-100 aperture:focus-visible:ring-2 aperture:focus-visible:ring-ring/50 aperture:pointer-coarse:w-8"
                  // Giving one up is not pressing the field: the list stays as it is.
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    chosen(value.filter((one) => one !== scope));
                  }}
                >
                  <XIcon className="aperture:pointer-events-none aperture:size-3" />
                </button>
              )}
            </span>
          ))}
        </span>
        <ChevronDownIcon
          aria-hidden
          className="aperture:pointer-events-none aperture:sticky aperture:top-0 aperture:mx-1 aperture:size-4 aperture:h-[calc(--spacing(5.25))] aperture:shrink-0 aperture:text-muted-foreground aperture:pointer-coarse:h-10"
        />
      </ComboboxPrimitive.Trigger>
      <ComboboxContent
        anchor={anchor}
        // Clear of what an on-screen keyboard covers: the list is typed into.
        collisionPadding={{ top: 8 + covered.top, bottom: 8 + covered.bottom, left: 8, right: 8 }}
      >
        <ComboboxInput
          showTrigger={false}
          aria-label={label === undefined ? "Search or add a scope" : `${label}: search or add`}
          placeholder="Search or add a scope"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          className="aperture:pointer-coarse:h-10!"
          onKeyDown={(event) => {
            // With nothing typed, it takes back the last that was chosen.
            const last = value.findLast((scope) => !required.includes(scope));
            if (event.key === "Backspace" && typed === "" && last !== undefined) {
              chosen(value.filter((scope) => scope !== last));
            }
          }}
        />
        <ComboboxEmpty>
          {word !== "" && !isScope(word) ? "A scope has no spaces or quotes in it." : "No scopes"}
        </ComboboxEmpty>
        <ComboboxList>
          {(group: Listed) => (
            <ComboboxGroup key={group.value} items={group.items}>
              {group.value === "" ? null : <ComboboxLabel>{group.value}</ComboboxLabel>}
              <ComboboxCollection>
                {(entry: Entry) => (
                  <ComboboxItem
                    key={entry.value}
                    value={entry}
                    indicator={entry.typed === true ? "check" : "checkbox"}
                    disabled={required.includes(entry.value)}
                    data-scope-option={entry.value}
                    data-scope-typed={entry.typed === true ? "" : undefined}
                  >
                    {entry.typed === true ? (
                      <span className="aperture:min-w-0 aperture:wrap-anywhere">
                        Add <span className="aperture:font-mono">«{entry.value}»</span>
                      </span>
                    ) : (
                      <span className="aperture:min-w-0 aperture:font-mono aperture:wrap-anywhere">
                        {entry.value}
                      </span>
                    )}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

export { ScopesPicker, isScope, type ScopesGroup };
