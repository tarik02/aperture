import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "./button.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "./field.tsx";
import { Input } from "./input.tsx";
import { ScrollArea } from "./scroll-area.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.tsx";

export type TagEntry = {
  key: string;
  value: string;
};

export function tagsToEntries(tags: Record<string, string>): TagEntry[] {
  return Object.entries(tags).map(([key, value]) => ({ key, value }));
}

export function entriesToTags(entries: TagEntry[]): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    const value = entry.value.trim();
    if (key && value) {
      tags[key] = value;
    }
  }
  return tags;
}

type TagEditorProps = {
  entries: TagEntry[];
  onChange: (entries: TagEntry[]) => void;
  error?: string | null;
  disabled?: boolean;
  hideLabel?: boolean;
};

export function TagEditor({ entries, onChange, error, disabled, hideLabel }: TagEditorProps) {
  const keyInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const pendingFocusIndexRef = useRef<number | null>(null);

  useEffect(() => {
    const pendingFocusIndex = pendingFocusIndexRef.current;
    if (pendingFocusIndex === null) {
      return;
    }

    pendingFocusIndexRef.current = null;
    keyInputRefs.current[pendingFocusIndex]?.focus();
  }, [entries.length]);

  function updateEntry(index: number, field: "key" | "value", value: string) {
    onChange(
      entries.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, [field]: value } : entry,
      ),
    );
  }

  function removeEntry(index: number) {
    onChange(entries.filter((_, entryIndex) => entryIndex !== index));
  }

  function addEntry() {
    pendingFocusIndexRef.current = entries.length;
    onChange([...entries, { key: "", value: "" }]);
  }

  return (
    <FieldGroup>
      <Field>
        <FieldLabel className={hideLabel ? "aperture:sr-only" : undefined}>Tags</FieldLabel>
        <ScrollArea scrollbars="horizontal" className="aperture:w-full aperture:pb-2">
          <Table
            scrollable={false}
            className="aperture:min-w-[28rem] aperture:[&_tr]:hover:bg-transparent"
          >
            <TableHeader>
              <TableRow className="aperture:hover:bg-transparent">
                <TableHead className="aperture:h-7 aperture:px-1">Key</TableHead>
                <TableHead className="aperture:h-7 aperture:px-1">Value</TableHead>
                <TableHead className="aperture:h-7 aperture:w-8 aperture:px-1 aperture:text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Add tag"
                    onClick={addEntry}
                    disabled={disabled}
                  >
                    <PlusIcon />
                  </Button>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.length === 0 ? (
                <TableRow className="aperture:hover:bg-transparent">
                  <TableCell
                    colSpan={3}
                    className="aperture:px-1 aperture:py-1.5 aperture:text-muted-foreground"
                  >
                    No tags
                  </TableCell>
                </TableRow>
              ) : (
                entries.map((entry, index) => (
                  <TableRow key={index} className="aperture:hover:bg-transparent">
                    <TableCell className="aperture:px-1 aperture:py-1">
                      <Input
                        ref={(element) => {
                          keyInputRefs.current[index] = element;
                        }}
                        placeholder="key"
                        value={entry.key}
                        onChange={(event) => updateEntry(index, "key", event.target.value)}
                        disabled={disabled}
                        className="aperture:h-7"
                      />
                    </TableCell>
                    <TableCell className="aperture:px-1 aperture:py-1">
                      <Input
                        placeholder="value"
                        value={entry.value}
                        onChange={(event) => updateEntry(index, "value", event.target.value)}
                        disabled={disabled}
                        className="aperture:h-7"
                      />
                    </TableCell>
                    <TableCell className="aperture:px-1 aperture:py-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove tag"
                        onClick={() => removeEntry(index)}
                        disabled={disabled}
                      >
                        <Trash2Icon />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </Field>
      {error ? (
        <Field data-invalid>
          <FieldError>{error}</FieldError>
        </Field>
      ) : null}
    </FieldGroup>
  );
}
