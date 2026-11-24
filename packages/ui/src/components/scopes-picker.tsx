"use client";

import * as React from "react";

import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "./combobox.tsx";
import { PickerChip, PickerContent, PickerSearch, PickerTrigger } from "./picker.tsx";

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
      <PickerTrigger
        id={id}
        anchor={anchor}
        aria-label={label}
        invalid={invalid}
        disabled={disabled}
        placeholder={placeholder}
        data-slot="scopes-picker"
        className={className}
      >
        {value.map((scope) => (
          <PickerChip
            key={scope}
            data-scope={scope}
            title={scope}
            className="aperture:font-mono"
            disabled={disabled}
            removeLabel={`Remove ${scope}`}
            onRemove={
              required.includes(scope)
                ? undefined
                : () => chosen(value.filter((one) => one !== scope))
            }
          >
            {scope}
          </PickerChip>
        ))}
      </PickerTrigger>
      <PickerContent anchor={anchor}>
        <PickerSearch
          aria-label={label === undefined ? "Search or add a scope" : `${label}: search or add`}
          placeholder="Search or add a scope"
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
      </PickerContent>
    </Combobox>
  );
}

export { ScopesPicker, isScope, type ScopesGroup };
