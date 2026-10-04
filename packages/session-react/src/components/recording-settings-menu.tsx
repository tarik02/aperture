import * as Schema from "effect/Schema";
import { RecordingSettings } from "@aperture-browser/api-client";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@aperture-browser/ui/components/dropdown-menu";

interface RecordingSettingsMenuProps {
  settings: RecordingSettings;
  onChange: (settings: RecordingSettings) => void;
}

export function RecordingSettingsMenuItems({ settings, onChange }: RecordingSettingsMenuProps) {
  const bursts = settings.capture === "bursts";
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Capture · Start recording</DropdownMenuLabel>
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
                Keep moments around automated actions and follow their tabs. Clicking or typing in
                this viewer does not trigger bursts.
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>
          Quiet stretches · edited copy
          <span className="aperture:block aperture:font-normal">
            {bursts
              ? "Choose Continuous to adjust pauses."
              : "Pauses with no detected screen changes or recorded events."}
          </span>
        </DropdownMenuLabel>
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
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuCheckboxItem
          checked={settings.presentation ?? false}
          closeOnClick={false}
          onCheckedChange={(presentation) => onChange({ ...settings, presentation })}
        >
          <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
            <span>Presentation pace</span>
            <span className="aperture:text-xs aperture:text-muted-foreground">
              Slow automation so viewers can follow its actions.
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={settings.ripple ?? false}
          closeOnClick={false}
          onCheckedChange={(ripple) => onChange({ ...settings, ripple })}
        >
          <span className="aperture:flex aperture:min-w-0 aperture:flex-col">
            <span>Highlight clicks</span>
            <span className="aperture:text-xs aperture:text-muted-foreground">
              Add a ripple around recorded clicks in the edited copy.
            </span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuLabel>
          Settings apply to new recordings. The full raw video downloads when you stop. When editing
          is enabled, an edited copy appears in session files.
        </DropdownMenuLabel>
      </DropdownMenuGroup>
    </>
  );
}
