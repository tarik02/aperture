import { CopyButton } from "#/components/resources/copy-button.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@aperture-browser/ui/components/input-group";

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
        className={mono ? "aperture:font-mono aperture:text-xs" : "aperture:text-xs"}
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
    <div className="aperture:grid aperture:grid-cols-[8rem_minmax(0,1fr)] aperture:items-center aperture:gap-3">
      <span className="aperture:text-xs aperture:text-muted-foreground">{label}</span>
      {input}
    </div>
  );
}
