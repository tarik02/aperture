import { FieldError } from "@aperture-browser/ui/components/field";
import { OTPField, OTPFieldInput } from "@aperture-browser/ui/components/otp-field";

const DIGITS = 6;

type CodeInputProps = {
  value: string;
  onChange: (code: string) => void;
  /** Hears the code once all of it is there: nothing else is left to do but give it. */
  onComplete: (code: string) => void;
  /** What the form's rules say of the code. */
  error?: string | undefined;
};

/**
 * An authenticator's code, a box for each digit, each a field of its own. Boxes drawn over
 * one hidden field (input-otp) are what Bitwarden offers to fill and then does not: before
 * it fills, it asks that the field be what is at its middle, and there a box was.
 */
export function CodeInput({ value, onChange, onComplete, error }: CodeInputProps) {
  return (
    <>
      <OTPField
        name="code"
        length={DIGITS}
        validationType="numeric"
        autoComplete="one-time-code"
        value={value}
        onValueChange={onChange}
        onValueComplete={onComplete}
      >
        {Array.from({ length: DIGITS }, (_, index) => (
          <OTPFieldInput
            key={index}
            aria-label={index === 0 ? "Code from your authenticator" : `Digit ${index + 1}`}
            aria-invalid={error === undefined ? undefined : true}
            autoFocus={index === 0}
          />
        ))}
      </OTPField>
      <FieldError reserved>{error}</FieldError>
    </>
  );
}
