import { Plus, Trash2 } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldError, FieldGroup } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";

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
  function updateEntry(index: number, field: "key" | "value", value: string) {
    onChange(entries.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)));
  }

  function removeEntry(index: number) {
    onChange(entries.filter((_, i) => i !== index));
  }

  function addEntry() {
    onChange([...entries, { key: "", value: "" }]);
  }

  return (
    <FieldGroup>
      {entries.map((entry, index) => (
        <div key={index} className="flex items-start gap-1.5">
          <Input
            placeholder="key"
            value={entry.key}
            onChange={(event) => updateEntry(index, "key", event.target.value)}
            disabled={disabled}
            className="flex-1"
          />
          <Input
            placeholder="value"
            value={entry.value}
            onChange={(event) => updateEntry(index, "value", event.target.value)}
            disabled={disabled}
            className="flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => removeEntry(index)}
            disabled={disabled}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Field data-invalid={error ? true : undefined}>
        <Button type="button" variant="outline" size="sm" onClick={addEntry} disabled={disabled}>
          <Plus />
          Tag
        </Button>
        <FieldError>{error}</FieldError>
      </Field>
    </FieldGroup>
  );
}
