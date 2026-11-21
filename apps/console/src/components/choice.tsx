import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aperture-browser/ui/components/select";

type ChoiceProps<Value extends string> = {
  value: Value;
  options: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  onChange: (value: Value) => void;
  size?: "sm" | "default";
  id?: string;
  "aria-label"?: string;
  className?: string;
};

/** One of a few things, chosen from a list that opens. */
export function Choice<Value extends string>({
  value,
  options,
  onChange,
  size,
  id,
  className,
  "aria-label": label,
}: ChoiceProps<Value>) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next !== null) {
          onChange(next);
        }
      }}
    >
      <SelectTrigger id={id} size={size} aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
