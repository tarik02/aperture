import { CopyButton } from "#/components/resources/copy-button.tsx";
import { Input } from "#/components/ui/input.tsx";

type CopyFieldProps = {
  value: string;
  label?: string;
  mono?: boolean;
};

export function CopyField({ value, label, mono = true }: CopyFieldProps) {
  return (
    <div className="flex items-center gap-1.5">
      {label ? <span className="shrink-0 text-xs text-muted-foreground">{label}</span> : null}
      <Input
        readOnly
        value={value}
        className={mono ? "font-mono text-xs" : "text-xs"}
        onFocus={(event) => event.currentTarget.select()}
      />
      <CopyButton value={value} />
    </div>
  );
}
