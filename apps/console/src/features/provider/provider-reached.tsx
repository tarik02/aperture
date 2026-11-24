import { Field, FieldError, FieldLabel } from "@aperture-browser/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@aperture-browser/ui/components/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@aperture-browser/ui/components/popover";
import { CircleCheck, CircleX } from "lucide-react";
import { useId, useRef, useState } from "react";
import { reveal } from "#/lib/reveal.ts";

/** What came of asking the provider how it is reached, or of a save that asked it. */
export type Reached =
  | { readonly state: "unasked" }
  | { readonly state: "asking" }
  | { readonly state: "reached" }
  | { readonly state: "refused"; readonly problems: ReadonlyArray<string> };

/** Whether it is reached, as a mark that stands in the field its address is typed into. */
function ReachedMark({ reached }: { reached: Reached }) {
  return reached.state === "reached" ? (
    <CircleCheck
      role="img"
      aria-label="Reached"
      className="aperture:text-emerald-600 aperture:dark:text-emerald-400"
    />
  ) : reached.state === "refused" ? (
    <CircleX role="img" aria-label="Not reached" className="aperture:text-destructive" />
  ) : null;
}

type ReachedLineProps = {
  reached: Reached;
  /** What the field's own rules say of what was typed, which is said before anything else. */
  said: string | undefined;
  /** The field the reasons open below, as wide as it. */
  anchor: React.RefObject<HTMLElement | null>;
};

/**
 * The line below the address: what its rules say, or that the provider is not reached as
 * one has to be. Why not is as many sentences as there are reasons, which a line does not
 * hold: they open beside it once they are there, and again where they are asked for.
 */
function ReachedLine({ reached, said, anchor }: ReachedLineProps) {
  // Not those of a refusal that was there before this was: they were shown when it came.
  const [open, setOpen] = useState(false);
  // The reasons of one refusal are shown once by themselves; another's are, again.
  const [shown, setShown] = useState(reached);
  if (shown !== reached) {
    setShown(reached);
    setOpen(true);
  }

  return (
    <div
      role="status"
      data-console-provider-reached={said === undefined ? reached.state : "invalid"}
      className="aperture:contents"
    >
      {said !== undefined ? (
        <FieldError ref={reveal} reserved>
          {said}
        </FieldError>
      ) : reached.state === "refused" ? (
        <FieldError ref={reveal} reserved role="none">
          Not reached.
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              data-console-provider-why
              className="aperture:ml-1.5 aperture:rounded-sm aperture:underline aperture:underline-offset-4 aperture:outline-none aperture:focus-visible:ring-3 aperture:focus-visible:ring-ring/50"
            >
              Why?
            </PopoverTrigger>
            <PopoverContent
              align="start"
              anchor={anchor}
              data-console-provider-problems
              // Not to the first of what the dialog holds: whoever asked is typing an address.
              initialFocus={false}
              className="aperture:w-(--anchor-width) aperture:text-foreground"
            >
              <ul className="aperture:flex aperture:flex-col aperture:gap-1.5 aperture:wrap-anywhere">
                {reached.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        </FieldError>
      ) : (
        <FieldError reserved />
      )}
    </div>
  );
}

type CheckedAddressProps = {
  label: string;
  name: string;
  value: string;
  placeholder?: string | undefined;
  /** Whether it is made of what is typed elsewhere, or is the provider's own: read, not typed. */
  fixed: boolean;
  /** What the field's own rules say of what was typed. */
  said: string | undefined;
  reached: Reached;
  onChange: (value: string) => void;
  onBlur: () => void;
  onCheck: () => void;
};

/**
 * The address a provider is asked at, with what asks it in the field itself: whether it is
 * reached is a mark beside what asks, and nothing is kept below the field for it but the
 * one line every field has.
 */
export function CheckedAddress({
  label,
  name,
  value,
  placeholder,
  fixed,
  said,
  reached,
  onChange,
  onBlur,
  onCheck,
}: CheckedAddressProps) {
  const id = useId();
  const group = useRef<HTMLDivElement>(null);
  const refused = said !== undefined || reached.state === "refused";
  return (
    <Field data-invalid={refused ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup ref={group}>
        <InputGroupInput
          id={id}
          name={name}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          readOnly={fixed}
          tabIndex={fixed ? -1 : undefined}
          placeholder={placeholder}
          className={fixed ? "aperture:text-muted-foreground" : undefined}
          value={value}
          aria-invalid={refused}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
        <InputGroupAddon align="inline-end">
          <ReachedMark reached={reached} />
          <InputGroupButton
            variant="secondary"
            data-console-provider-check
            pending={reached.state === "asking"}
            onClick={onCheck}
          >
            Check
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <ReachedLine reached={reached} said={said} anchor={group} />
    </Field>
  );
}
