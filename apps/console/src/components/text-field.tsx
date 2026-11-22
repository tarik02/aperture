import { Field, FieldError, FieldLabel } from "@aperture-browser/ui/components/field";
import { Input } from "@aperture-browser/ui/components/input";
import type { AnyFieldApi } from "@tanstack/react-form";
import { type ComponentProps, useId } from "react";
import { reveal } from "#/lib/reveal.ts";

type TextFieldProps = Omit<ComponentProps<typeof Input>, "value" | "onChange" | "onBlur"> & {
  field: AnyFieldApi;
  label: string;
  /** Whether the label is only read out, where the field stands in a row that has no room. */
  labelHidden?: boolean;
  /**
   * What was refused of what the form sent, said where the field's rules say theirs: on
   * the line that is kept for it, so that nothing moves when it is said.
   */
  refused?: string | undefined;
};

/** A form's field of text: its label, what is typed, and what its rules say of that. */
export function TextField({
  field,
  label,
  labelHidden = false,
  refused,
  ...input
}: TextFieldProps) {
  const id = useId();
  const errors: ReadonlyArray<unknown> = field.state.meta.errors;
  const said = errors.find((error) => typeof error === "string") ?? refused;

  return (
    <Field data-invalid={said === undefined ? undefined : true}>
      <FieldLabel
        htmlFor={id}
        // Narrow as well: a field makes what it holds as wide as itself, and a label that is
        // only read out would reach as far past the edge of the dialog it stands in.
        className={labelHidden ? "aperture:sr-only aperture:w-px!" : undefined}
      >
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
      <FieldError ref={reveal} reserved>
        {said}
      </FieldError>
    </Field>
  );
}
