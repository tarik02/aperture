import { Badge } from "@aperture-browser/ui/components/badge";
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
import type { Person } from "#/lib/identity.ts";
import { required } from "#/lib/validation.ts";

/** How far turning the second factor on has come. */
type Enrolling =
  | { readonly step: "none" }
  | {
      readonly step: "confirm";
      readonly uri: string;
      readonly secret: string;
      readonly backupCodes: ReadonlyArray<string>;
    }
  | { readonly step: "backup-codes"; readonly backupCodes: ReadonlyArray<string> };

type AccountSecurityDialogProps = {
  person: Person;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * A person's second factor: turned on with an authenticator that is shown to have the secret,
 * and turned off, each with the password.
 */
export function AccountSecurityDialog({ person, open, onOpenChange }: AccountSecurityDialogProps) {
  return (
    // What was typed and told is gone with the dialog: the codes are shown once.
    <FreshDialog open={open} onOpenChange={onOpenChange} height="28rem">
      <Security person={person} onDone={() => onOpenChange(false)} />
    </FreshDialog>
  );
}

function Security({ person, onDone }: { person: Person; onDone: () => void }) {
  const [enrolling, setEnrolling] = useState<Enrolling>({ step: "none" });

  return (
    <>
      <DialogHeader>
        <DialogTitle>Account security</DialogTitle>
        <DialogDescription>{person.email}</DialogDescription>
      </DialogHeader>
      {enrolling.step === "backup-codes" ? (
        <>
          <DialogBody data-console-security-dialog="backup-codes">
            <div data-console-backup-codes>
              <CopyField
                label="Backup codes, shown once"
                value={enrolling.backupCodes.join("\n")}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={onDone}>
              Done
            </Button>
          </DialogFooter>
        </>
      ) : enrolling.step === "confirm" ? (
        <Confirm
          enrolling={enrolling}
          onConfirmed={() =>
            setEnrolling({ step: "backup-codes", backupCodes: enrolling.backupCodes })
          }
          onDone={onDone}
        />
      ) : (
        <WithPassword person={person} onEnrolling={setEnrolling} onDone={onDone} />
      )}
    </>
  );
}

/** What is done with the password: the second factor turned on or off, or its backup codes renewed. */
function WithPassword({
  person,
  onEnrolling,
  onDone,
}: {
  person: Person;
  onEnrolling: (enrolling: Enrolling) => void;
  onDone: () => void;
}) {
  const enrol = useEnrolMutation();
  const turnOff = useTurnSecondFactorOffMutation();
  const renew = useRenewBackupCodesMutation();
  const form = useForm({
    defaultValues: { password: "" },
    onSubmitMeta: { renew: false },
    onSubmit: async ({ value, meta, formApi }) => {
      try {
        if (meta.renew) {
          const backupCodes = await renew.mutateAsync(value.password);
          onEnrolling({ step: "backup-codes", backupCodes });
        } else if (person.secondFactor) {
          await turnOff.mutateAsync(value.password);
          formApi.reset();
          toast.success("Two-factor sign-in is off");
        } else {
          onEnrolling({ step: "confirm", ...(await enrol.mutateAsync(value.password)) });
        }
      } catch {
        // The mutation tells of it.
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
        void form.handleSubmit({ renew: false });
      }}
    >
      <DialogBody>
        <div className="aperture:flex aperture:items-center aperture:justify-between aperture:gap-2 aperture:text-sm">
          Two-factor sign-in
          <Badge
            data-console-second-factor={person.secondFactor ? "on" : "off"}
            variant={person.secondFactor ? "default" : "outline"}
          >
            {person.secondFactor ? "On" : "Off"}
          </Badge>
        </div>
        <form.Field name="password" validators={{ onSubmit: required("Your password") }}>
          {(field) => (
            <TextField
              field={field}
              label="Password"
              type="password"
              autoComplete="current-password"
            />
          )}
        </form.Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Close
        </Button>
        {person.secondFactor ? (
          <Button
            type="button"
            variant="outline"
            data-console-renew-backup-codes
            disabled={submitting}
            onClick={() => void form.handleSubmit({ renew: true })}
          >
            New backup codes
          </Button>
        ) : null}
        <Button
          type="submit"
          variant={person.secondFactor ? "destructive" : "default"}
          disabled={submitting}
        >
          {person.secondFactor ? "Turn off" : "Turn on"}
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
  enrolling: Extract<Enrolling, { step: "confirm" }>;
  onConfirmed: () => void;
  onDone: () => void;
}) {
  const confirm = useConfirmEnrolmentMutation();
  /** Whether what the picture says is shown as text in its place, for whoever cannot scan it. */
  const [manual, setManual] = useState(false);
  const form = useForm({
    defaultValues: { code: "" },
    onSubmit: async ({ value, formApi }) => {
      try {
        await confirm.mutateAsync(value.code.trim());
      } catch {
        // A code that was not taken is typed anew.
        formApi.reset();
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
            className="aperture:shrink-0 aperture:self-center"
          />
        )}
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
              error={field.state.meta.errors.find((error) => typeof error === "string")}
              onComplete={() => (submitting ? undefined : void form.handleSubmit())}
            />
          )}
        </form.Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          Confirm
        </Button>
      </DialogFooter>
    </form>
  );
}
