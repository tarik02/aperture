import { Trash2 } from "lucide-react";
import { Toggle } from "@aperture-browser/ui/components/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";

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
            className="aperture:text-muted-foreground aperture:hover:text-foreground aperture:aria-pressed:bg-muted/60 aperture:aria-pressed:text-foreground"
          />
        }
      >
        <Trash2 />
      </TooltipTrigger>
      <TooltipContent>Include deleted</TooltipContent>
    </Tooltip>
  );
}
