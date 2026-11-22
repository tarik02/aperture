import { Avatar, AvatarFallback } from "@aperture-browser/ui/components/avatar";
import { Button } from "@aperture-browser/ui/components/button";
import { Field, FieldError, FieldLabel } from "@aperture-browser/ui/components/field";
import { Popover, PopoverContent, PopoverTrigger } from "@aperture-browser/ui/components/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@aperture-browser/ui/components/select";
import { ExternalLink, Info } from "lucide-react";
import { useId } from "react";
import { type Preset, PRESETS, presetOf } from "#/features/provider/provider-presets.ts";

/** A provider's mark: its letters, since no provider's own mark is drawn here. */
function PresetMark({ preset }: { preset: Preset }) {
  return (
    <Avatar aria-hidden className="aperture:size-5 aperture:rounded-md aperture:after:rounded-md">
      <AvatarFallback className="aperture:rounded-md aperture:text-[0.625rem] aperture:font-semibold aperture:tracking-tight">
        {preset.mark}
      </AvatarFallback>
    </Avatar>
  );
}

function PresetOption({ preset }: { preset: Preset }) {
  return (
    <SelectItem value={preset.id} data-console-provider-preset-option={preset.id}>
      <PresetMark preset={preset} />
      {preset.name}
    </SelectItem>
  );
}

type ProviderPresetPickerProps = {
  value: string;
  onChange: (preset: Preset) => void;
};

/**
 * Which provider is added, among those that are known: what is known of it fills the form
 * in, and where a client is registered with it is a link beside its name.
 */
export function ProviderPresetPicker({ value, onChange }: ProviderPresetPickerProps) {
  const id = useId();
  const preset = presetOf(value);
  const known = PRESETS.filter((one) => one.providerId !== "");
  const others = PRESETS.filter((one) => one.providerId === "");

  return (
    <Field>
      <div className="aperture:flex aperture:items-center aperture:justify-between aperture:gap-2">
        <FieldLabel htmlFor={id}>Provider</FieldLabel>
        {/* As tall as the label alone, so that the link and the note move nothing. */}
        <div className="aperture:flex aperture:h-3.5 aperture:items-center aperture:gap-1">
          {preset.note === undefined ? null : (
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-touch-dense
                    aria-label={`What to know of ${preset.name}`}
                    data-console-provider-preset-note
                  />
                }
              >
                <Info />
              </PopoverTrigger>
              <PopoverContent align="end" className="aperture:w-72 aperture:text-pretty">
                {preset.note}
              </PopoverContent>
            </Popover>
          )}
          {preset.register === undefined ? null : (
            <a
              href={preset.register}
              target="_blank"
              rel="noreferrer"
              data-console-provider-preset-register
              className="aperture:inline-flex aperture:items-center aperture:gap-1 aperture:rounded-sm aperture:text-xs aperture:text-muted-foreground aperture:underline-offset-4 aperture:outline-none aperture:hover:text-foreground aperture:hover:underline aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50"
            >
              Register a client
              <ExternalLink className="aperture:size-3" />
            </a>
          )}
        </div>
      </div>
      <Select
        items={PRESETS.map((one) => ({ value: one.id, label: one.name }))}
        value={value}
        onValueChange={(next) => {
          if (next !== null && next !== value) {
            onChange(presetOf(next));
          }
        }}
      >
        <SelectTrigger id={id} data-console-provider-preset={value} className="aperture:w-full">
          <SelectValue>
            {() => (
              <>
                <PresetMark preset={preset} />
                {preset.name}
              </>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {known.map((one) => (
              <PresetOption key={one.id} preset={one} />
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            {others.map((one) => (
              <PresetOption key={one.id} preset={one} />
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldError reserved />
    </Field>
  );
}
