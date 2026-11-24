import { Button } from "@aperture-browser/ui/components/button";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { QrCode } from "@aperture-browser/ui/components/qr-code";
import { useForm, useStore } from "@tanstack/react-form";
import { useState } from "react";
import { toast } from "sonner";
import { CodeInput } from "#/components/code-input.tsx";
import { CopyField } from "#/components/copy-field.tsx";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { TextField } from "#/components/text-field.tsx";
import {
  useConfirmEnrolmentMutation,
  useEnrolMutation,
  useRenewBackupCodesMutation,
  useTurnSecondFactorOffMutation,
} from "#/features/auth/auth.queries.ts";
import { told } from "#/lib/api.ts";
import type { Person } from "#/lib/identity.ts";
import { required } from "#/lib/validation.ts";

/** What is done with the second factor, each with the password: on, off, or its backup codes anew. */
export type SecondFactorDoing = "on" | "off" | "renew";

/** How far it has come: the password is asked first, whatever is done. */
type Step =
  | { readonly step: "none" }
  | {
      readonly step: "confirm";
      readonly uri: string;
      readonly secret: string;
      readonly backupCodes: ReadonlyArray<string>;
    }
  | { readonly step: "backup-codes"; readonly backupCodes: ReadonlyArray<string> };

const TITLE: Record<SecondFactorDoing, string> = {
  on: "Turn two-factor sign-in on",
  off: "Turn two-factor sign-in off",
  renew: "New backup codes",
};

type SecondFactorDialogProps = {
  person: Person;
  doing: SecondFactorDoing;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Turns a person's second factor on, with an authenticator that is shown to have the
 * secret, or off, or makes its backup codes anew: each with the password, and each a
 * step that is as tall as what it holds, since a step is another thing to do.
 */
export function SecondFactorDialog({ person, doing, open, onOpenChange }: SecondFactorDialogProps) {
  const [step, setStep] = useState<Step["step"]>("none");
  // It opens at its first step each time.
  const shown = open ? step : "none";

  return (
    <FreshDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setStep("none");
        }
        onOpenChange(next);
      }}
      // The backup codes are shown once: Done closes them, and nothing done in passing.
      dismissible={shown !== "backup-codes"}
    >
      <Steps
        person={person}
        doing={doing}
        onStep={setStep}
        onDone={() => {
          setStep("none");
          onOpenChange(false);
        }}
      />
    </FreshDialog>
  );
}

function Steps({
  person,
  doing,
  onStep,
  onDone,
}: {
  person: Person;
  doing: SecondFactorDoing;
  onStep: (step: Step["step"]) => void;
  onDone: () => void;
}) {
  const [at, setAt] = useState<Step>({ step: "none" });
  const go = (next: Step) => {
    setAt(next);
    onStep(next.step);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{TITLE[doing]}</DialogTitle>
        <DialogDescription>{person.email}</DialogDescription>
      </DialogHeader>
      {at.step === "backup-codes" ? (
        <>
          <DialogBody data-console-security-dialog="backup-codes">
            <div data-console-backup-codes>
              <CopyField label="Backup codes, shown once" value={at.backupCodes.join("\n")} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={onDone}>
              Done
            </Button>
          </DialogFooter>
        </>
      ) : at.step === "confirm" ? (
        <Confirm
          enrolling={at}
          onConfirmed={() => go({ step: "backup-codes", backupCodes: at.backupCodes })}
          onDone={onDone}
        />
      ) : (
        <WithPassword doing={doing} onStep={go} onDone={onDone} />
      )}
    </>
  );
}

/** Asks the password, and does with it what was asked for. */
function WithPassword({
  doing,
  onStep,
  onDone,
}: {
  doing: SecondFactorDoing;
  onStep: (step: Step) => void;
  onDone: () => void;
}) {
  const enrol = useEnrolMutation();
  const turnOff = useTurnSecondFactorOffMutation();
  const renew = useRenewBackupCodesMutation();
  const [refused, setRefused] = useState<string>();
  const form = useForm({
    defaultValues: { password: "" },
    onSubmit: async ({ value }) => {
      setRefused(undefined);
      try {
        if (doing === "renew") {
          const backupCodes = await renew.mutateAsync(value.password);
          onStep({ step: "backup-codes", backupCodes });
        } else if (doing === "off") {
          await turnOff.mutateAsync(value.password);
          toast.success("Two-factor sign-in is off");
          onDone();
        } else {
          onStep({ step: "confirm", ...(await enrol.mutateAsync(value.password)) });
        }
      } catch (error) {
        setRefused(told(error, "That was not done."));
      }
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <form
      data-console-security-dialog="none"
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogBody>
        <form.Field name="password" validators={{ onSubmit: required("Your password") }}>
          {(field) => (
            <TextField
              field={field}
              label="Password"
              type="password"
              autoFocus
              autoComplete="current-password"
              refused={refused}
            />
          )}
        </form.Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant={doing === "off" ? "destructive" : "default"}
          pending={submitting}
        >
          {doing === "off" ? "Turn off" : "Continue"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Shows an authenticator what to keep, and takes a code of its to show that it does. */
function Confirm({
  enrolling,
  onConfirmed,
  onDone,
}: {
  enrolling: Extract<Step, { step: "confirm" }>;
  onConfirmed: () => void;
  onDone: () => void;
}) {
  const confirm = useConfirmEnrolmentMutation();
  /** Whether what the picture says is shown as text in its place, for whoever cannot scan it. */
  const [manual, setManual] = useState(false);
  const [refused, setRefused] = useState<string>();
  const form = useForm({
    defaultValues: { code: "" },
    onSubmit: async ({ value, formApi }) => {
      setRefused(undefined);
      try {
        await confirm.mutateAsync(value.code.trim());
      } catch (error) {
        // A code that was not taken is typed anew; why is said below it.
        formApi.reset();
        setRefused(told(error, "That code was not taken."));
        return;
      }
      toast.success("Two-factor sign-in is on");
      onConfirmed();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <form
      data-console-security-dialog="confirm"
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogBody>
        {/*
          As tall as the picture, which is as tall as it is wide, whichever of the two it
          shows; and no taller than leaves the whole of the step in a window that is short.
        */}
        <div className="aperture:@container aperture:w-full aperture:shrink-0">
          <div className="aperture:flex aperture:h-[max(11rem,min(100cqw,calc(100svh-21rem)))] aperture:flex-col aperture:gap-4 aperture:overflow-y-auto">
            {manual ? (
              <>
                <div data-console-totp-uri>
                  <CopyField label="Setup address" value={enrolling.uri} />
                </div>
                <CopyField label="Secret" value={enrolling.secret} />
              </>
            ) : (
              <QrCode
                data-console-totp-qr
                value={enrolling.uri}
                label="Setup address for an authenticator"
                className="aperture:aspect-square aperture:size-auto aperture:h-full aperture:self-center"
              />
            )}
          </div>
        </div>
        <Button
          type="button"
          variant="link"
          data-console-totp-manual
          className="aperture:h-auto aperture:self-start aperture:p-0"
          onClick={() => setManual(!manual)}
        >
          {manual ? "Scan it instead" : "Can't scan it?"}
        </Button>
        <form.Field name="code" validators={{ onSubmit: required("The code") }}>
          {(field) => (
            <CodeInput
              value={field.state.value}
              onChange={field.handleChange}
              error={field.state.meta.errors.find((error) => typeof error === "string") ?? refused}
              onComplete={() => (submitting ? undefined : void form.handleSubmit())}
            />
          )}
        </form.Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={submitting}>
          Confirm
        </Button>
      </DialogFooter>
    </form>
  );
}
