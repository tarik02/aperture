import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { cn } from "@aperture-browser/ui/utils";
import { themeOptions, useThemeMode } from "#/components/theme-mode.ts";

/** Light, dark or following the system, as three icon buttons. */
export function ThemeToggle() {
  const { mode, changeMode } = useThemeMode();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="aperture:flex aperture:gap-0.5 aperture:rounded-lg aperture:bg-sidebar-accent/60 aperture:p-0.5 aperture:group-data-[collapsible=icon]:hidden"
    >
      {themeOptions.map((option) => (
        <Tooltip key={option.value}>
          <TooltipTrigger
            render={
              <button
                type="button"
                role="radio"
                aria-checked={mode === option.value}
                aria-label={option.label}
                onClick={() => changeMode(option.value)}
                className={cn(
                  "aperture:flex aperture:h-6 aperture:flex-1 aperture:items-center aperture:justify-center aperture:rounded-md aperture:text-sidebar-foreground/60 aperture:transition-colors aperture:hover:text-sidebar-foreground aperture:[&_svg]:size-3.5",
                  mode === option.value &&
                    "aperture:bg-sidebar aperture:text-sidebar-foreground aperture:shadow-xs",
                )}
              />
            }
          >
            <option.icon />
          </TooltipTrigger>
          <TooltipContent side="top">{option.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
