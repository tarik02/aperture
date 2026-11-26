import { FieldError } from "@aperture-browser/ui/components/field";
import { Input } from "@aperture-browser/ui/components/input";

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
 * An authenticator's code, in one plain field. A box for each digit drawn over a hidden
 * field (input-otp) is one a password manager offers to fill and then does not: Bitwarden's
 * inline suggestion closes and leaves it empty. A code given with a space in it, as
 * authenticators show it, is taken as its digits.
 */
export function CodeInput({ value, onChange, onComplete, error }: CodeInputProps) {
  return (
    <>
      <Input
        name="code"
        aria-label="Code from your authenticator"
        aria-invalid={error === undefined ? undefined : true}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        placeholder="000000"
        className="aperture:h-10 aperture:text-center aperture:indent-[0.3em] aperture:font-mono aperture:text-xl aperture:tracking-[0.3em] aperture:tabular-nums aperture:md:text-xl"
        value={value}
        onChange={(event) => {
          const code = event.target.value.replace(/\D/g, "").slice(0, DIGITS);
          onChange(code);
          if (code.length === DIGITS) {
            onComplete(code);
          }
        }}
      />
      <FieldError reserved>{error}</FieldError>
    </>
  );
}
