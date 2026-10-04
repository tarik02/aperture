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
        <DropdownMenuLabel>Tab capture · new recordings</DropdownMenuLabel>
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
            Continuous
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="bursts" closeOnClick={false}>
            Automation bursts
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Quiet stretches · continuous capture</DropdownMenuLabel>
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
            Keep
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="cut" disabled={bursts} closeOnClick={false}>
            Cut
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="speed" disabled={bursts} closeOnClick={false}>
            Speed up
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
          Presentation pace
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={settings.ripple ?? false}
          closeOnClick={false}
          onCheckedChange={(ripple) => onChange({ ...settings, ripple })}
        >
          Highlight clicks
        </DropdownMenuCheckboxItem>
      </DropdownMenuGroup>
    </>
  );
}
