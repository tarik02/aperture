import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import type { DeletedFilterValue } from "#/hooks/queries/keys.ts";

const deletedStatusOptions: Array<{ value: DeletedFilterValue; label: string }> = [
  { value: "active", label: "Active" },
  { value: "deleted", label: "Deleted" },
  { value: "all", label: "All" },
];

type DeletedStatusSelectProps = {
  value: DeletedFilterValue;
  onChange: (value: DeletedFilterValue) => void;
};

export function DeletedStatusSelect({ value, onChange }: DeletedStatusSelectProps) {
  return (
    <Select
      items={deletedStatusOptions}
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue === "active" || nextValue === "deleted" || nextValue === "all") {
          onChange(nextValue);
        }
      }}
    >
      <SelectTrigger size="sm" className="w-28">
        <SelectValue>
          {(selectedValue: unknown) =>
            deletedStatusOptions.find((option) => option.value === selectedValue)?.label ?? "Status"
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {deletedStatusOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
