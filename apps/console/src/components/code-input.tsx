import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@aperture-browser/ui/components/input-otp";

const DIGITS = 6;
const HALF = DIGITS / 2;
const ONLY_DIGITS = "^\\d+$";

type CodeInputProps = {
  value: string;
  onChange: (code: string) => void;
  /** Hears the code once all of it is there: nothing else is left to do but give it. */
  onComplete: (code: string) => void;
};

/** An authenticator's code, a box for each digit. */
export function CodeInput({ value, onChange, onComplete }: CodeInputProps) {
  return (
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
        {Array.from({ length: HALF }, (_, index) => (
          <InputOTPSlot key={index} index={index} />
        ))}
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup className="aperture:flex-1">
        {Array.from({ length: HALF }, (_, index) => (
          <InputOTPSlot key={index} index={index + HALF} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );
}
