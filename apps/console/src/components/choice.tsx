import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@aperture-browser/ui/components/select";

type Option<Value extends string> = { readonly value: Value; readonly label: string };

type ChoiceProps<Value extends string> = {
  value: Value;
  options: ReadonlyArray<Option<Value>>;
  /** More to choose from after the options, those of one thing together under what it is. */
  groups?: ReadonlyArray<{
    readonly label: string;
    readonly options: ReadonlyArray<Option<Value>>;
  }>;
  onChange: (value: Value) => void;
  size?: "sm" | "default";
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
};

/** One of a few things, chosen from a list that opens. */
export function Choice<Value extends string>({
  value,
  options,
  groups = [],
  onChange,
  size,
  disabled,
  id,
  className,
  "aria-label": label,
}: ChoiceProps<Value>) {
  return (
    <Select
      items={[...options, ...groups.flatMap((group) => group.options)]}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) {
          onChange(next);
        }
      }}
    >
      <SelectTrigger id={id} size={size} aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      {/* A list in groups is long: it opens below what opens it, as wide as it needs. */}
      <SelectContent
        {...(groups.length === 0
          ? {}
          : { align: "end", alignItemWithTrigger: false, className: "aperture:min-w-60" })}
      >
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
        {groups.map((group) => (
          <SelectGroup key={group.label}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
