import { useId, useState } from "react";
import * as Schema from "effect/Schema";
import { RecordingSettings } from "@aperture-browser/api-client";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@aperture-browser/ui/components/field";
import { Switch } from "@aperture-browser/ui/components/switch";
import { ToggleGroup, ToggleGroupItem } from "@aperture-browser/ui/components/toggle-group";

export function RecordingSettingsDialog({
  mode,
  disabled,
  onClose,
  onStart,
}: {
  mode: "tab" | "viewer";
  disabled: boolean;
  onClose: () => void;
  onStart: (settings: RecordingSettings) => void;
}) {
  const id = useId();
  const [settings, setSettings] = useState<RecordingSettings>({ capture: "continuous" });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "tab" ? "Record this tab" : "Record this viewer"}</DialogTitle>
          <DialogDescription>
            The raw video downloads when you stop. An edited copy appears in session files after
            processing.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          {mode === "tab" && (
            <Field>
              <FieldLabel id={`${id}-capture`}>Capture</FieldLabel>
              <ToggleGroup
                aria-labelledby={`${id}-capture`}
                variant="outline"
                value={[settings.capture ?? "continuous"]}
                onValueChange={(values) => {
                  if (values.length === 0) return;
                  const capture = Schema.decodeUnknownSync(RecordingSettings.fields.capture)(
                    values[0],
                  );
                  setSettings((current) => {
                    const { idle: _idle, ...rest } = current;
                    return capture === "bursts" ? { ...rest, capture } : { ...current, capture };
                  });
                }}
              >
                <ToggleGroupItem value="continuous">Continuous</ToggleGroupItem>
                <ToggleGroupItem value="bursts">Automation bursts</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                {settings.capture === "bursts"
                  ? "Follow automation across tabs and keep the moments around each action."
                  : "Keep the whole recording of this tab."}
              </FieldDescription>
            </Field>
          )}
          {settings.capture !== "bursts" && (
            <Field>
              <FieldLabel id={`${id}-idle`}>Quiet stretches</FieldLabel>
              <ToggleGroup
                aria-labelledby={`${id}-idle`}
                variant="outline"
                value={[settings.idle ?? "keep"]}
                onValueChange={(values) => {
                  if (values.length === 0) return;
                  if (values[0] === "keep") {
                    setSettings(({ idle: _idle, ...rest }) => rest);
                    return;
                  }
                  const idle = Schema.decodeUnknownSync(RecordingSettings.fields.idle)(values[0]);
                  setSettings((current) => ({ ...current, idle }));
                }}
              >
                <ToggleGroupItem value="keep">Keep</ToggleGroupItem>
                <ToggleGroupItem value="cut">Cut</ToggleGroupItem>
                <ToggleGroupItem value="speed">Speed up</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>Shorten pauses in the edited copy.</FieldDescription>
            </Field>
          )}
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={`${id}-presentation`}>Presentation pace</FieldLabel>
              <FieldDescription>
                Slow automation so viewers can follow pointer movements and clicks.
              </FieldDescription>
            </FieldContent>
            <Switch
              id={`${id}-presentation`}
              checked={settings.presentation ?? false}
              onCheckedChange={(presentation) =>
                setSettings((current) => ({ ...current, presentation }))
              }
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={`${id}-ripple`}>Highlight clicks</FieldLabel>
              <FieldDescription>Show a ripple around clicks in the edited copy.</FieldDescription>
            </FieldContent>
            <Switch
              id={`${id}-ripple`}
              checked={settings.ripple ?? false}
              onCheckedChange={(ripple) => setSettings((current) => ({ ...current, ripple }))}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={disabled} onClick={() => onStart(settings)}>
            Start recording
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
