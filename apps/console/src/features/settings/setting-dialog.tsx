import { SETTINGS, type SettingEntry, type SettingValue } from "@aperture-browser/control-api";
import { Button } from "@aperture-browser/ui/components/button";
import { Checkbox } from "@aperture-browser/ui/components/checkbox";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import {
  Field,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@aperture-browser/ui/components/field";
import { Input } from "@aperture-browser/ui/components/input";
import { useForm, useStore } from "@tanstack/react-form";
import { useId } from "react";
import { Choice } from "#/components/choice.tsx";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import {
  effectiveWords,
  inUnits,
  LEVEL_WORDS,
  secondsOf,
  SETTING_WORDS,
  type Unit,
  UNITS,
  valueWords,
} from "#/features/settings/setting-words.ts";
import {
  type SettingsTarget,
  type SettingView,
  useSetSettingMutation,
} from "#/features/settings/settings.queries.ts";

type SettingDialogProps = {
  target: SettingsTarget;
  setting: SettingView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Says what a level says of one setting: its value, and the bounds of the levels below. */
export function SettingDialog({ open, onOpenChange, ...form }: SettingDialogProps) {
  return (
    <FreshDialog open={open} onOpenChange={onOpenChange} className="aperture:sm:max-w-lg">
      <SettingForm {...form} onDone={() => onOpenChange(false)} />
    </FreshDialog>
  );
}

type Mode = "unset" | "none" | "set";

const amountOf = (value: number | undefined, unit: Unit) =>
  value === undefined ? "" : String(value / secondsOf(1, unit));

function SettingForm({
  target,
  setting,
  onDone,
}: Omit<SettingDialogProps, "open" | "onOpenChange"> & { onDone: () => void }) {
  const { key, here, above, effective } = setting;
  const definition = SETTINGS[key];
  const kind = definition.type.kind;
  const choices: ReadonlyArray<string | boolean> =
    definition.type.kind === "choice" ? definition.type.choices : [];
  const words = SETTING_WORDS[key];
  const set = useSetSettingMutation(target);
  const ids = { value: useId(), unit: useId(), min: useId(), max: useId() };
  // A session has no level below it to hold.
  const bounds = target.level !== "session";
  const said = here?.value;
  const unit: Unit =
    kind === "duration"
      ? inUnits(
          typeof said === "number"
            ? said
            : (here?.max ??
                here?.min ??
                (typeof effective.value === "number" ? effective.value : 3600)),
        ).unit
      : "minutes";
  const scale = (amount: string, unit: Unit) =>
    kind === "duration" ? Math.round(secondsOf(Number(amount), unit)) : Number(amount);

  const form = useForm({
    defaultValues: {
      mode: (said === undefined ? "unset" : said === null ? "none" : "set") as Mode,
      amount:
        typeof said === "number" ? (kind === "duration" ? amountOf(said, unit) : String(said)) : "",
      choice: said === undefined || said === null ? String(choices[0] ?? "") : String(said),
      unit,
      min: kind === "duration" ? amountOf(here?.min, unit) : String(here?.min ?? ""),
      max: kind === "duration" ? amountOf(here?.max, unit) : String(here?.max ?? ""),
      allowed: (here?.allowed ?? []).map(String),
    },
    onSubmit: async ({ value }) => {
      const choice = (text: string) => choices.find((one) => String(one) === text) ?? text;
      const entry: {
        value?: SettingValue;
        min?: number;
        max?: number;
        allowed?: ReadonlyArray<SettingValue>;
      } = {};
      if (kind === "choice") {
        if (value.mode === "set") {
          entry.value = choice(value.choice);
        }
        if (bounds && value.allowed.length > 0) {
          entry.allowed = value.allowed.map(choice);
        }
      } else {
        if (value.mode === "none") {
          entry.value = null;
        } else if (value.mode === "set") {
          entry.value = scale(value.amount, value.unit);
        }
        if (bounds && value.min.trim() !== "") {
          entry.min = scale(value.min, value.unit);
        }
        if (bounds && value.max.trim() !== "") {
          entry.max = scale(value.max, value.unit);
        }
      }
      try {
        await set.mutateAsync({ key, entry: entry satisfies SettingEntry });
      } catch {
        // The mutation tells of it.
        return;
      }
      onDone();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const mode = useStore(form.store, (state) => state.values.mode);
  const chosenUnit = useStore(form.store, (state) => state.values.unit);
  const modes = [
    { value: "unset" as const, label: "As above" },
    ...(kind === "choice"
      ? [{ value: "set" as const, label: "Choose" }]
      : [
          ...(definition.none ? [{ value: "none" as const, label: words.none ?? "None" }] : []),
          { value: "set" as const, label: kind === "duration" ? "After" : "At most" },
        ]),
  ];
  const bound = (end: "min" | "max") => above[end];
  const number = (text: string) => text.trim() === "" || Number(text) >= 0;

  return (
    <form
      data-console-setting-dialog={key}
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{words.label}</DialogTitle>
        <DialogDescription>
          For this {LEVEL_WORDS[target.level]}: {effectiveWords(key, effective)}
        </DialogDescription>
      </DialogHeader>
      <DialogBody height="calc(15rem + 4 * var(--control-height))">
        <div className="aperture:grid aperture:grid-cols-[minmax(0,10rem)_1fr] aperture:gap-2">
          <form.Field name="mode">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={ids.value}>Value</FieldLabel>
                <Choice
                  id={ids.value}
                  className="aperture:w-full"
                  value={field.state.value}
                  options={modes}
                  onChange={field.handleChange}
                />
              </Field>
            )}
          </form.Field>
          {kind === "choice" ? (
            <form.Field name="choice">
              {(field) =>
                mode === "set" ? (
                  <Field>
                    <FieldLabel className="aperture:invisible">Choice</FieldLabel>
                    <Choice
                      aria-label="Choice"
                      className="aperture:w-full"
                      value={field.state.value}
                      options={choices.map((one) => ({
                        value: String(one),
                        label: valueWords(key, one),
                      }))}
                      onChange={field.handleChange}
                    />
                  </Field>
                ) : (
                  <span />
                )
              }
            </form.Field>
          ) : (
            <div className="aperture:flex aperture:items-end aperture:gap-2">
              <form.Field
                name="amount"
                validators={{
                  onSubmit: ({ value }) =>
                    mode === "set" && !(Number(value) > 0) ? "Say how much." : undefined,
                }}
              >
                {(field) => (
                  <Field data-invalid={field.state.meta.errors.length > 0 ? true : undefined}>
                    <FieldLabel className="aperture:invisible">Amount</FieldLabel>
                    <Input
                      aria-label="Amount"
                      inputMode="decimal"
                      disabled={mode !== "set"}
                      value={field.state.value}
                      aria-invalid={field.state.meta.errors.length > 0}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                  </Field>
                )}
              </form.Field>
              {kind === "duration" ? (
                <form.Field name="unit">
                  {(field) => (
                    <Field className="aperture:w-32 aperture:shrink-0">
                      <FieldLabel htmlFor={ids.unit} className="aperture:invisible">
                        Unit
                      </FieldLabel>
                      <Choice
                        id={ids.unit}
                        className="aperture:w-full"
                        value={field.state.value}
                        options={UNITS}
                        onChange={field.handleChange}
                      />
                    </Field>
                  )}
                </form.Field>
              ) : null}
            </div>
          )}
        </div>
        {bounds ? (
          <FieldSet className="aperture:gap-2">
            <FieldLegend variant="label">Bounds for the levels below</FieldLegend>
            {kind === "choice" ? (
              <form.Field name="allowed">
                {(field) => (
                  <div className="aperture:grid aperture:gap-2">
                    {choices.map((one) => {
                      const text = String(one);
                      const out = above.allowed !== null && !above.allowed.values.includes(one);
                      return (
                        <label
                          key={text}
                          className="aperture:flex aperture:items-center aperture:gap-2.5 aperture:text-sm"
                        >
                          <Checkbox
                            data-console-setting-allowed={text}
                            disabled={out}
                            checked={field.state.value.includes(text)}
                            onCheckedChange={(checked) =>
                              field.handleChange(
                                checked
                                  ? [...field.state.value, text]
                                  : field.state.value.filter((kept) => kept !== text),
                              )
                            }
                          />
                          {valueWords(key, one)}
                          {out ? (
                            <span className="aperture:text-muted-foreground">
                              · not allowed by the {LEVEL_WORDS[above.allowed?.level ?? "instance"]}
                            </span>
                          ) : null}
                        </label>
                      );
                    })}
                    <FieldError reserved>
                      {field.state.value.length === 0
                        ? "None ticked: every choice is allowed."
                        : null}
                    </FieldError>
                  </div>
                )}
              </form.Field>
            ) : (
              <div className="aperture:grid aperture:grid-cols-2 aperture:gap-2">
                {(["min", "max"] as const).map((end) => (
                  <form.Field
                    key={end}
                    name={end}
                    validators={{
                      onSubmit: ({ value }) => (number(value) ? undefined : "Not below zero."),
                    }}
                  >
                    {(field) => {
                      const limit = bound(end);
                      const error = field.state.meta.errors.find((one) => typeof one === "string");
                      return (
                        <Field data-invalid={error === undefined ? undefined : true}>
                          <FieldLabel htmlFor={ids[end]}>
                            {end === "min" ? "At least" : "At most"}
                            {kind === "duration" ? ` (${chosenUnit})` : ""}
                          </FieldLabel>
                          <Input
                            id={ids[end]}
                            inputMode="decimal"
                            placeholder={
                              limit === null
                                ? "No bound"
                                : `${valueWords(key, limit.value)} from ${LEVEL_WORDS[limit.level]}`
                            }
                            value={field.state.value}
                            aria-invalid={error !== undefined}
                            onChange={(event) => field.handleChange(event.target.value)}
                          />
                          <FieldError reserved>{error}</FieldError>
                        </Field>
                      );
                    }}
                  </form.Field>
                ))}
              </div>
            )}
          </FieldSet>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={submitting}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
