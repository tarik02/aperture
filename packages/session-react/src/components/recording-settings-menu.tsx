import * as Schema from "effect/Schema";
import { RecordingSettings } from "@aperture-browser/api-client";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";

interface RecordingSettingsMenuProps {
  settings: RecordingSettings;
  onChange: (settings: RecordingSettings) => void;
}

export function RecordingSettingsMenuItems({ settings, onChange }: RecordingSettingsMenuProps) {
  const bursts = settings.capture === "bursts";
  const idleLabel =
    settings.idle === "cut" ? "Cut" : settings.idle === "speed" ? "Speed up 8×" : "Keep";
  const pace = settings.pace ?? "fast";
  const paceLabel = pace === "instant" ? "Instant" : pace === "slow" ? "Slow" : "Fast";
  const natural =
    settings.motion === "natural" ||
    (typeof settings.motion === "object" && settings.motion.type === "natural");
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>New recording</DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:justify-between aperture:gap-3">
              <span className="aperture:shrink-0">Capture</span>
              <span className="aperture:truncate aperture:text-muted-foreground">
                {bursts ? "Bursts" : "Continuous"}
              </span>
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="aperture:w-64">
            <DropdownMenuGroup>
              <DropdownMenuRadioGroup
                aria-label="Tab capture"
                value={settings.capture ?? "continuous"}
                onValueChange={(value) => {
                  const capture = Schema.decodeUnknownSync(RecordingSettings.fields.capture)(value);
                  const { idle: _idle, ...rest } = settings;
                  onChange(capture === "bursts" ? { ...rest, capture } : { ...settings, capture });
                }}
              >
                <DropdownMenuRadioItem value="continuous" closeOnClick={false}>
                  <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
                    <span>Continuous</span>
                    <span className="aperture:text-xs aperture:text-muted-foreground">
                      Keep this tab, including manual actions.
                    </span>
                  </span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="bursts" closeOnClick={false}>
                  <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
                    <span>Automation bursts</span>
                    <span className="aperture:text-xs aperture:text-muted-foreground">
                      Keep moments around automated actions and follow their tabs. Clicking or
                      typing in this viewer does not trigger bursts.
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:justify-between aperture:gap-3">
              <span className="aperture:shrink-0">Quiet stretches</span>
              <span className="aperture:truncate aperture:text-muted-foreground">
                {bursts ? "Continuous only" : idleLabel}
              </span>
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="aperture:w-64">
            <DropdownMenuGroup>
              <DropdownMenuRadioGroup
                aria-label="Quiet stretches"
                value={settings.idle ?? "keep"}
                onValueChange={(value) => {
                  if (value === "keep") {
                    const { idle: _idle, ...rest } = settings;
                    onChange(rest);
                  } else {
                    const idle = Schema.decodeUnknownSync(RecordingSettings.fields.idle)(value);
                    onChange({ ...settings, idle });
                  }
                }}
              >
                <DropdownMenuRadioItem value="keep" disabled={bursts} closeOnClick={false}>
                  <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
                    <span>Keep</span>
                    <span className="aperture:text-xs aperture:text-muted-foreground">
                      Leave pauses at normal speed.
                    </span>
                  </span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="cut" disabled={bursts} closeOnClick={false}>
                  <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
                    <span>Cut</span>
                    <span className="aperture:text-xs aperture:text-muted-foreground">
                      Remove quiet pauses, keeping brief context around activity.
                    </span>
                  </span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="speed" disabled={bursts} closeOnClick={false}>
                  <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
                    <span>Speed up</span>
                    <span className="aperture:text-xs aperture:text-muted-foreground">
                      Play those pauses at 8× speed.
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:items-center aperture:justify-between aperture:gap-3">
              <span className="aperture:shrink-0">Automation pace</span>
              <span className="aperture:truncate aperture:text-muted-foreground">{paceLabel}</span>
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="aperture:w-64">
            <DropdownMenuGroup>
              <DropdownMenuRadioGroup
                aria-label="Automation pace"
                value={pace}
                onValueChange={(value) => {
                  const pace = Schema.decodeUnknownSync(RecordingSettings.fields.pace)(value);
                  onChange({ ...settings, pace });
                }}
              >
                <DropdownMenuRadioItem value="instant" closeOnClick={false}>
                  <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
                    <span>Instant</span>
                    <span className="aperture:text-xs aperture:text-muted-foreground">
                      The pointer jumps straight to each action.
                    </span>
                  </span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="fast" closeOnClick={false}>
                  <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
                    <span>Fast</span>
                    <span className="aperture:text-xs aperture:text-muted-foreground">
                      Quick pointer travel that is still easy to follow.
                    </span>
                  </span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="slow" closeOnClick={false}>
                  <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
                    <span>Slow</span>
                    <span className="aperture:text-xs aperture:text-muted-foreground">
                      Unhurried travel and longer pauses before clicks, for demos.
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuCheckboxItem
                checked={natural}
                disabled={pace === "instant"}
                closeOnClick={false}
                onCheckedChange={(checked) =>
                  onChange({ ...settings, motion: checked ? "natural" : "linear" })
                }
              />
            }
          >
            Natural pointer motion
          </TooltipTrigger>
          <TooltipContent side="left">
            Only while recording: the pointer travels in curves and now and then overshoots a
            little, like a hand. Manual input is unaffected.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuCheckboxItem
                checked={settings.ripple ?? false}
                closeOnClick={false}
                onCheckedChange={(ripple) => onChange({ ...settings, ripple })}
              />
            }
          >
            Highlight clicks
          </TooltipTrigger>
          <TooltipContent side="left">
            Add a ripple around recorded clicks in the edited copy. The raw video stays unchanged.
          </TooltipContent>
        </Tooltip>
      </DropdownMenuGroup>
    </>
  );
}
