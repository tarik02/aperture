import { Field, FieldError, FieldLabel } from "@aperture-browser/ui/components/field";
import { Input } from "@aperture-browser/ui/components/input";
import type { AnyFieldApi } from "@tanstack/react-form";
import { type ComponentProps, useId } from "react";

type TextFieldProps = Omit<ComponentProps<typeof Input>, "value" | "onChange" | "onBlur"> & {
  field: AnyFieldApi;
  label: string;
  /** Whether the label is only read out, where the field stands in a row that has no room. */
  labelHidden?: boolean;
};

/** A form's field of text: its label, what is typed, and what its rules say of that. */
export function TextField({ field, label, labelHidden = false, ...input }: TextFieldProps) {
  const id = useId();
  const errors: ReadonlyArray<unknown> = field.state.meta.errors;
  const said = errors.find((error) => typeof error === "string");

  return (
    <Field data-invalid={said === undefined ? undefined : true}>
      <FieldLabel htmlFor={id} className={labelHidden ? "aperture:sr-only" : undefined}>
        {label}
      </FieldLabel>
      <Input
        id={id}
        name={field.name}
        value={field.state.value}
        aria-invalid={said !== undefined}
        onChange={(event) => field.handleChange(event.target.value)}
        onBlur={field.handleBlur}
        {...input}
      />
      <FieldError>{said}</FieldError>
    </Field>
  );
}
