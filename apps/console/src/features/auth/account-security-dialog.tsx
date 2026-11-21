import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Input } from "@aperture-browser/ui/components/input";
import { QrCode } from "@aperture-browser/ui/components/qr-code";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { CopyField } from "#/components/copy-field.tsx";
import {
  useConfirmEnrolmentMutation,
  useEnrolMutation,
  useRenewBackupCodesMutation,
  useTurnSecondFactorOffMutation,
} from "#/features/auth/auth.queries.ts";
import type { Person } from "#/lib/identity.ts";

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
  const enrol = useEnrolMutation();
  const confirm = useConfirmEnrolmentMutation();
  const turnOff = useTurnSecondFactorOffMutation();
  const renew = useRenewBackupCodesMutation();
  const [enrolling, setEnrolling] = useState<Enrolling>({ step: "none" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  /** Whether what the picture says is shown as text as well, for whoever cannot scan it. */
  const [manual, setManual] = useState(false);

  const close = (next: boolean) => {
    if (!next) {
      // What was typed and told is gone with the dialog: the codes are shown once.
      setEnrolling({ step: "none" });
      setManual(false);
      setPassword("");
      setCode("");
    }
    onOpenChange(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (enrolling.step === "confirm") {
      confirm.mutate(code.trim(), {
        onSuccess: () => {
          setCode("");
          setEnrolling({ step: "backup-codes", backupCodes: enrolling.backupCodes });
          toast.success("Two-factor sign-in is on");
        },
      });
    } else if (person.secondFactor) {
      turnOff.mutate(password, {
        onSuccess: () => {
          setPassword("");
          toast.success("Two-factor sign-in is off");
        },
      });
    } else {
      enrol.mutate(password, {
        onSuccess: (made) => {
          setPassword("");
          setEnrolling({ step: "confirm", ...made });
        },
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          data-console-security-dialog={enrolling.step}
          onSubmit={submit}
          className="aperture:grid aperture:min-w-0 aperture:gap-4"
        >
          <DialogHeader>
            <DialogTitle>Account security</DialogTitle>
            <DialogDescription>{person.email}</DialogDescription>
          </DialogHeader>
          {enrolling.step === "backup-codes" ? (
            <>
              <div data-console-backup-codes>
                <CopyField
                  label="Backup codes, shown once"
                  value={enrolling.backupCodes.join("\n")}
                />
              </div>
              <DialogFooter>
                <Button type="button" onClick={() => close(false)}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : enrolling.step === "confirm" ? (
            <>
              <QrCode
                data-console-totp-qr
                value={enrolling.uri}
                label="Setup address for an authenticator"
                className="aperture:size-auto aperture:w-full"
              />
              {manual ? (
                <>
                  <div data-console-totp-uri>
                    <CopyField label="Setup address" value={enrolling.uri} />
                  </div>
                  <CopyField label="Secret" value={enrolling.secret} />
                </>
              ) : (
                <Button
                  type="button"
                  variant="link"
                  data-console-totp-manual
                  className="aperture:h-auto aperture:justify-self-start aperture:p-0"
                  onClick={() => setManual(true)}
                >
                  Can't scan it?
                </Button>
              )}
              <label className="aperture:grid aperture:gap-1.5 aperture:text-sm">
                Code
                <Input
                  name="code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  autoFocus
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => close(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={confirm.isPending || code.trim() === ""}>
                  Confirm
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="aperture:flex aperture:items-center aperture:justify-between aperture:gap-2 aperture:text-sm">
                Two-factor sign-in
                <Badge
                  data-console-second-factor={person.secondFactor ? "on" : "off"}
                  variant={person.secondFactor ? "default" : "outline"}
                >
                  {person.secondFactor ? "On" : "Off"}
                </Badge>
              </div>
              <label className="aperture:grid aperture:gap-1.5 aperture:text-sm">
                Password
                <Input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => close(false)}>
                  Close
                </Button>
                {person.secondFactor ? (
                  <Button
                    type="button"
                    variant="outline"
                    data-console-renew-backup-codes
                    disabled={renew.isPending || password === ""}
                    onClick={() =>
                      renew.mutate(password, {
                        onSuccess: (backupCodes) => {
                          setPassword("");
                          setEnrolling({ step: "backup-codes", backupCodes });
                        },
                      })
                    }
                  >
                    New backup codes
                  </Button>
                ) : null}
                {person.secondFactor ? (
                  <Button
                    type="submit"
                    variant="destructive"
                    disabled={turnOff.isPending || password === ""}
                  >
                    Turn off
                  </Button>
                ) : (
                  <Button type="submit" disabled={enrol.isPending || password === ""}>
                    Turn on
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
