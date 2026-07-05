import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table.tsx";

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
};

export function TagEditor({ entries, onChange, error, disabled }: TagEditorProps) {
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
    onChange(entries.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)));
  }

  function removeEntry(index: number) {
    onChange(entries.filter((_, i) => i !== index));
  }

  function addEntry() {
    pendingFocusIndexRef.current = entries.length;
    onChange([...entries, { key: "", value: "" }]);
  }

  return (
    <FieldGroup>
      <Field>
        <FieldLabel>Tags</FieldLabel>
        <Table className="[&_tr]:hover:bg-transparent">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-7 px-1">Key</TableHead>
              <TableHead className="h-7 px-1">Value</TableHead>
              <TableHead className="h-7 w-8 px-1 text-right">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Add tag"
                  onClick={addEntry}
                  disabled={disabled}
                >
                  <Plus />
                </Button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="px-1 py-1.5 text-muted-foreground">
                  No tags
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry, index) => (
                <TableRow key={index} className="hover:bg-transparent">
                  <TableCell className="px-1 py-1">
                    <Input
                      ref={(element) => {
                        keyInputRefs.current[index] = element;
                      }}
                      placeholder="key"
                      value={entry.key}
                      onChange={(event) => updateEntry(index, "key", event.target.value)}
                      disabled={disabled}
                      className="h-7"
                    />
                  </TableCell>
                  <TableCell className="px-1 py-1">
                    <Input
                      placeholder="value"
                      value={entry.value}
                      onChange={(event) => updateEntry(index, "value", event.target.value)}
                      disabled={disabled}
                      className="h-7"
                    />
                  </TableCell>
                  <TableCell className="px-1 py-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove tag"
                      onClick={() => removeEntry(index)}
                      disabled={disabled}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Field>
      {error ? (
        <Field data-invalid>
          <FieldError>{error}</FieldError>
        </Field>
      ) : null}
    </FieldGroup>
  );
}
