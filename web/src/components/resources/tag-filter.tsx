import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";

type TagFilterProps = {
  tagKey?: string;
  tagValue?: string;
  onApply: (tagKey?: string, tagValue?: string) => void;
};

export function TagFilter({ tagKey, tagValue, onApply }: TagFilterProps) {
  const [keyInput, setKeyInput] = useState(tagKey ?? "");
  const [valueInput, setValueInput] = useState(tagValue ?? "");

  function handleApply() {
    const nextKey = keyInput.trim();
    const nextValue = valueInput.trim();
    onApply(nextKey || undefined, nextValue || undefined);
  }

  function handleClear() {
    setKeyInput("");
    setValueInput("");
    onApply(undefined, undefined);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        placeholder="tag key"
        value={keyInput}
        onChange={(event) => setKeyInput(event.target.value)}
        className="h-7 w-28"
      />
      <Input
        placeholder="tag value"
        value={valueInput}
        onChange={(event) => setValueInput(event.target.value)}
        className="h-7 w-28"
      />
      <Button type="button" variant="outline" size="sm" onClick={handleApply}>
        Filter
      </Button>
      {tagKey || tagValue ? (
        <Button type="button" variant="ghost" size="sm" onClick={handleClear}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}
