import { Label } from "#/components/ui/label.tsx";
import { Switch } from "#/components/ui/switch.tsx";

type IncludeDeletedToggleProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

export function IncludeDeletedToggle({ checked, onCheckedChange }: IncludeDeletedToggleProps) {
  return (
    <div className="flex items-center gap-2">
      <Switch id="include-deleted" checked={checked} onCheckedChange={onCheckedChange} />
      <Label htmlFor="include-deleted" className="text-sm font-normal">
        Deleted
      </Label>
    </div>
  );
}
