import { Trash2 } from "lucide-react";
import { Toggle } from "#/components/ui/toggle.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";

type IncludeDeletedToggleProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
};

export function IncludeDeletedToggle({ checked, onCheckedChange }: IncludeDeletedToggleProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            pressed={checked}
            onPressedChange={onCheckedChange}
            variant="default"
            size="sm"
            aria-label="Include deleted"
            className="text-muted-foreground hover:text-foreground aria-pressed:bg-muted/60 aria-pressed:text-foreground"
          />
        }
      >
        <Trash2 />
      </TooltipTrigger>
      <TooltipContent>Include deleted</TooltipContent>
    </Tooltip>
  );
}
