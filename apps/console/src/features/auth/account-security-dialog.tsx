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
import { Tabs, TabsList, TabsTrigger } from "@aperture-browser/ui/components/tabs";
import { useForm, useStore } from "@tanstack/react-form";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CodeInput } from "#/components/code-input.tsx";
import { CopyField } from "#/components/copy-field.tsx";
import { LinesSkeleton } from "#/components/list-skeleton.tsx";
import { FreshDialog } from "#/components/fresh-dialog.tsx";
import { TextField } from "#/components/text-field.tsx";
import {
  useAddPasskeyMutation,
  useRemovePasskeyMutation,
  useRenamePasskeyMutation,
} from "#/features/auth/auth.mutations.ts";
import {
  useConfirmEnrolmentMutation,
  useEnrolMutation,
  usePasskeysQuery,
  useRenewBackupCodesMutation,
  useTurnSecondFactorOffMutation,
} from "#/features/auth/auth.queries.ts";
import { told } from "#/lib/api.ts";
import { calledOff, type Passkey, passkeysSupported, type Person } from "#/lib/identity.ts";
import { required } from "#/lib/validation.ts";

/** How far turning the second factor on has come, or what is done with a passkey. */
type Enrolling =
  | { readonly step: "none" }
  /** A passkey is named: the one there is, or one that is added under the name. */
  | { readonly step: "passkey-name"; readonly passkey?: Passkey }
  | { readonly step: "passkey-remove"; readonly passkey: Passkey }
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
 * How a person signs in beside their password. Their second factor: turned on with an
 * authenticator that is shown to have the secret, and turned off, each with the password.
 * And their passkeys: added, named anew and removed.
 */
export function AccountSecurityDialog({ person, open, onOpenChange }: AccountSecurityDialogProps) {
  const [step, setStep] = useState<Enrolling["step"]>("none");
  // It opens at its first step each time.
  const shown = open ? step : "none";

  return (
    // What was typed and told is gone with the dialog: the codes are shown once.
    <FreshDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setStep("none");
        }
        onOpenChange(next);
      }}
      // Each step has the height it needs, and the dialog moves from one to the next: a
      // step is another thing to do, not the same form with more in it.
      // Not `duration-200`: that would also slow the dialog's leaving, past its backdrop's.
      className="aperture:transition-[height] aperture:[transition-duration:200ms] aperture:ease-out"
      height={HEIGHTS[shown]}
      // The backup codes are shown once: Done closes them, and nothing done in passing.
      dismissible={shown !== "backup-codes"}
    >
      <Security person={person} onStep={setStep} onDone={() => onOpenChange(false)} />
    </FreshDialog>
  );
}

/** The code to scan is as wide as the dialog and fits whole; the other steps hold little. */
const HEIGHTS: Record<Enrolling["step"], string> = {
  none: "24rem",
  "passkey-name": "24rem",
  "passkey-remove": "24rem",
  confirm: "42rem",
  "backup-codes": "25rem",
};

function Security({
  person,
  onStep,
  onDone,
}: {
  person: Person;
  onStep: (step: Enrolling["step"]) => void;
  onDone: () => void;
}) {
  const [enrolling, setEnrollingStep] = useState<Enrolling>({ step: "none" });
  const [tab, setTab] = useState<Tab>("second-factor");
  const setEnrolling = (next: Enrolling) => {
    setEnrollingStep(next);
    onStep(next.step);
  };

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
      ) : enrolling.step === "passkey-name" ? (
        <PasskeyName passkey={enrolling.passkey} onDone={() => setEnrolling({ step: "none" })} />
      ) : enrolling.step === "passkey-remove" ? (
        <PasskeyRemove passkey={enrolling.passkey} onDone={() => setEnrolling({ step: "none" })} />
      ) : (
        <>
          <Tabs
            value={tab}
            className="aperture:shrink-0"
            onValueChange={(next) => setTab(next === "passkeys" ? "passkeys" : "second-factor")}
          >
            <TabsList className="aperture:w-full">
              <TabsTrigger value="second-factor" data-console-security-tab="second-factor">
                Two-factor
              </TabsTrigger>
              <TabsTrigger value="passkeys" data-console-security-tab="passkeys">
                Passkeys
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {tab === "passkeys" ? (
            <Passkeys onEnrolling={setEnrolling} onDone={onDone} />
          ) : (
            <WithPassword person={person} onEnrolling={setEnrolling} onDone={onDone} />
          )}
        </>
      )}
    </>
  );
}

type Tab = "second-factor" | "passkeys";

const added = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** The passkeys a person has, each with the ways to name it anew and to remove it. */
function Passkeys({
  onEnrolling,
  onDone,
}: {
  onEnrolling: (enrolling: Enrolling) => void;
  onDone: () => void;
}) {
  const passkeys = usePasskeysQuery(true);

  return (
    <>
      <DialogBody data-console-security-dialog="passkeys">
        {passkeys.isError ? (
          <p role="alert" className="aperture:text-sm aperture:text-destructive">
            {told(passkeys.error)}
          </p>
        ) : passkeys.isPending ? (
          <LinesSkeleton lines={2} />
        ) : passkeys.data?.length === 0 ? (
          <p data-console-empty className="aperture:text-sm aperture:text-muted-foreground">
            No passkeys yet.
          </p>
        ) : (
          <ul data-console-passkeys className="aperture:grid aperture:gap-2">
            {passkeys.data?.map((passkey) => (
              <li
                key={passkey.id}
                data-console-passkey={passkey.name}
                className="aperture:flex aperture:items-center aperture:gap-2 aperture:text-sm"
              >
                <span className="aperture:grid aperture:min-w-0 aperture:flex-1">
                  <span className="aperture:truncate aperture:font-medium">{passkey.name}</span>
                  {passkey.createdAt === undefined ? null : (
                    <span className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
                      Added {added.format(passkey.createdAt)}
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  data-console-passkey-rename
                  aria-label={`Rename ${passkey.name}`}
                  onClick={() => onEnrolling({ step: "passkey-name", passkey })}
                >
                  <Pencil />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  data-console-passkey-remove
                  aria-label={`Remove ${passkey.name}`}
                  onClick={() => onEnrolling({ step: "passkey-remove", passkey })}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Close
        </Button>
        <Button
          type="button"
          data-console-passkey-add
          disabled={!passkeysSupported()}
          onClick={() => onEnrolling({ step: "passkey-name" })}
        >
          Add a passkey
        </Button>
      </DialogFooter>
    </>
  );
}

/** Names a passkey: the one there is, or one an authenticator is then asked to make. */
function PasskeyName({ passkey, onDone }: { passkey: Passkey | undefined; onDone: () => void }) {
  const add = useAddPasskeyMutation();
  const rename = useRenamePasskeyMutation();
  const [refused, setRefused] = useState<string>();
  const form = useForm({
    defaultValues: { name: passkey?.name ?? "" },
    onSubmit: async ({ value }) => {
      const name = value.name.trim();
      setRefused(undefined);
      try {
        await (passkey === undefined
          ? add.mutateAsync(name)
          : rename.mutateAsync({ id: passkey.id, name }));
      } catch (error) {
        // Whoever called it off themselves is told nothing of that.
        setRefused(
          calledOff(error)
            ? undefined
            : told(error, passkey === undefined ? "No passkey was added." : "It was not renamed."),
        );
        return;
      }
      onDone();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <form
      data-console-security-dialog="passkey-name"
      className="aperture:contents"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogBody>
        <form.Field name="name" validators={{ onSubmit: required("A name") }}>
          {(field) => (
            <TextField
              field={field}
              label={passkey === undefined ? "Name of the new passkey" : "Name of the passkey"}
              placeholder="Laptop"
              autoFocus
              autoComplete="off"
              refused={refused}
            />
          )}
        </form.Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={submitting}>
          {passkey === undefined ? "Add" : "Rename"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function PasskeyRemove({ passkey, onDone }: { passkey: Passkey; onDone: () => void }) {
  const remove = useRemovePasskeyMutation();

  return (
    <>
      <DialogBody data-console-security-dialog="passkey-remove">
        <p className="aperture:text-sm">
          Remove the passkey <span className="aperture:font-medium">{passkey.name}</span>? Nobody
          signs in with it after.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          data-console-passkey-remove-confirm
          disabled={remove.isPending}
          onClick={() => remove.mutate(passkey.id, { onSuccess: onDone })}
        >
          Remove
        </Button>
      </DialogFooter>
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
  const [refused, setRefused] = useState<string>();
  const form = useForm({
    defaultValues: { password: "" },
    onSubmitMeta: { renew: false },
    onSubmit: async ({ value, meta, formApi }) => {
      setRefused(undefined);
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
              refused={refused}
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
          pending={submitting}
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
            className="aperture:size-auto aperture:w-full aperture:shrink-0"
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
