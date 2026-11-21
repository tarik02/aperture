import { FieldError } from "@aperture-browser/ui/components/field";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@aperture-browser/ui/components/input-otp";

const DIGITS = 6;
const ONLY_DIGITS = "^\\d+$";

type CodeInputProps = {
  value: string;
  onChange: (code: string) => void;
  /** Hears the code once all of it is there: nothing else is left to do but give it. */
  onComplete: (code: string) => void;
  /** What the form's rules say of the code. */
  error?: string | undefined;
};

/** An authenticator's code, a box for each digit. */
export function CodeInput({ value, onChange, onComplete, error }: CodeInputProps) {
  return (
    <>
      <InputOTP
        name="code"
        aria-label="Code from your authenticator"
        maxLength={DIGITS}
        pattern={ONLY_DIGITS}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        value={value}
        onChange={onChange}
        onComplete={onComplete}
        containerClassName="aperture:w-full"
      >
        <InputOTPGroup className="aperture:flex-1">
          {Array.from({ length: DIGITS }, (_, index) => (
            <InputOTPSlot key={index} index={index} />
          ))}
        </InputOTPGroup>
      </InputOTP>
      <FieldError>{error}</FieldError>
    </>
  );
}
