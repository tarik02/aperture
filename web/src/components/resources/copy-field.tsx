import { CopyButton } from "#/components/resources/copy-button.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "#/components/ui/input-group.tsx";

type CopyFieldProps = {
  value: string;
  label?: string;
  mono?: boolean;
};

export function CopyField({ value, label, mono = true }: CopyFieldProps) {
  const input = (
    <InputGroup>
      <InputGroupInput
        readOnly
        value={value}
        className={mono ? "font-mono text-xs" : "text-xs"}
        aria-label={label ?? "Copyable value"}
        onFocus={(event) => event.currentTarget.select()}
      />
      <InputGroupAddon align="inline-end">
        <CopyButton value={value} render={<InputGroupButton size="icon-xs" />} />
      </InputGroupAddon>
    </InputGroup>
  );

  if (!label) {
    return input;
  }

  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      {input}
    </div>
  );
}
