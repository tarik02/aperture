import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, RefreshCw, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "#/components/resources/confirm-dialog.tsx";
import { CopyButton } from "#/components/resources/copy-button.tsx";
import { CopyField } from "#/components/resources/copy-field.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "#/components/ui/dialog.tsx";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs.tsx";
import { apiClient } from "#/lib/api/client.ts";
import { queryKeys } from "#/lib/api/query-keys.ts";
import type { TOTPEnrollment } from "#/lib/api/schemas.ts";

type TOTPFlow =
  | { kind: "idle" }
  | { kind: "enrollment"; enrollment: TOTPEnrollment; code: string }
  | { kind: "recovery-codes"; codes: string[] };

type PendingAction =
  | "password"
  | "begin-totp"
  | "finish-totp"
  | "recovery-codes"
  | "disable-totp"
  | null;

type SecurityModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SecurityModal({ open, onOpenChange }: SecurityModalProps) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.securityStatus,
    queryFn: () => apiClient.getSecurityStatus(),
    enabled: open,
  });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [totpFlow, setTOTPFlow] = useState<TOTPFlow>({ kind: "idle" });
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [disableOpen, setDisableOpen] = useState(false);

  async function handlePasswordSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    setPendingAction("password");
    try {
      await apiClient.setPassword(currentPassword, newPassword);
      await queryClient.invalidateQueries({ queryKey: queryKeys.securityStatus });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success(status.data?.hasPassword ? "Password changed" : "Password set");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Password update failed");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleBeginTOTP() {
    setPendingAction("begin-totp");
    try {
      const enrollment = await apiClient.beginTOTPEnrollment();
      setTOTPFlow({ kind: "enrollment", enrollment, code: "" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Authenticator setup failed");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleFinishTOTP(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (totpFlow.kind !== "enrollment") {
      return;
    }
    setPendingAction("finish-totp");
    try {
      const result = await apiClient.completeTOTPEnrollment(totpFlow.code);
      await queryClient.invalidateQueries({ queryKey: queryKeys.securityStatus });
      setTOTPFlow({ kind: "recovery-codes", codes: result.recoveryCodes });
      toast.success("Authenticator enabled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Authenticator verification failed");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleRegenerateRecoveryCodes() {
    setPendingAction("recovery-codes");
    try {
      const result = await apiClient.regenerateRecoveryCodes(verificationCode);
      await queryClient.invalidateQueries({ queryKey: queryKeys.securityStatus });
      setVerificationCode("");
      setTOTPFlow({ kind: "recovery-codes", codes: result.recoveryCodes });
      toast.success("Recovery codes replaced");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Recovery code replacement failed");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleDisableTOTP() {
    setPendingAction("disable-totp");
    try {
      await apiClient.disableTOTP(verificationCode);
      await queryClient.invalidateQueries({ queryKey: queryKeys.securityStatus });
      setVerificationCode("");
      setTOTPFlow({ kind: "idle" });
      toast.success("Authenticator disabled");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Authenticator disable failed");
      throw error;
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Security</DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="password">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="password">
                <KeyRound data-icon="inline-start" />
                Password
              </TabsTrigger>
              <TabsTrigger value="two-factor">
                <ShieldCheck data-icon="inline-start" />
                Two-factor
              </TabsTrigger>
            </TabsList>

            <TabsContent value="password" className="pt-3">
              {status.isPending ? (
                <div className="flex flex-col gap-3">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : status.isError ? (
                <p className="text-sm text-destructive">Could not load security settings.</p>
              ) : (
                <form onSubmit={(event) => void handlePasswordSubmit(event)}>
                  <FieldGroup>
                    {status.data.hasPassword ? (
                      <Field>
                        <FieldLabel htmlFor="security-current-password">
                          Current password
                        </FieldLabel>
                        <Input
                          id="security-current-password"
                          type="password"
                          autoComplete="current-password"
                          value={currentPassword}
                          onChange={(event) => setCurrentPassword(event.target.value)}
                          disabled={pendingAction !== null}
                          required
                        />
                      </Field>
                    ) : null}
                    <Field>
                      <FieldLabel htmlFor="security-new-password">New password</FieldLabel>
                      <Input
                        id="security-new-password"
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={1024}
                        value={newPassword}
                        onChange={(event) => setNewPassword(event.target.value)}
                        disabled={pendingAction !== null}
                        required
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="security-confirm-password">Confirm password</FieldLabel>
                      <Input
                        id="security-confirm-password"
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={1024}
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                        disabled={pendingAction !== null}
                        required
                      />
                    </Field>
                    <Button
                      type="submit"
                      className="self-end"
                      disabled={pendingAction !== null || !newPassword || !confirmPassword}
                    >
                      <KeyRound data-icon="inline-start" />
                      {status.data.hasPassword ? "Change password" : "Set password"}
                    </Button>
                  </FieldGroup>
                </form>
              )}
            </TabsContent>

            <TabsContent value="two-factor" className="pt-3">
              {status.isPending ? (
                <div className="flex flex-col gap-3">
                  <Skeleton className="h-48 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : status.isError ? (
                <p className="text-sm text-destructive">Could not load security settings.</p>
              ) : totpFlow.kind === "enrollment" ? (
                <form onSubmit={(event) => void handleFinishTOTP(event)}>
                  <FieldGroup>
                    <div className="flex justify-center">
                      <img
                        src={totpFlow.enrollment.qrCodeDataUrl}
                        alt="Authenticator QR code"
                        width={192}
                        height={192}
                        className="size-48 rounded-md bg-white p-2"
                      />
                    </div>
                    <CopyField value={totpFlow.enrollment.secret} label="Secret" />
                    <Field>
                      <FieldLabel htmlFor="totp-enrollment-code">Authenticator code</FieldLabel>
                      <Input
                        id="totp-enrollment-code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        value={totpFlow.code}
                        onChange={(event) => setTOTPFlow({ ...totpFlow, code: event.target.value })}
                        disabled={pendingAction !== null}
                        required
                      />
                    </Field>
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={pendingAction !== null}
                        onClick={() => void handleBeginTOTP()}
                      >
                        <RefreshCw data-icon="inline-start" />
                        Restart
                      </Button>
                      <Button
                        type="submit"
                        disabled={pendingAction !== null || !totpFlow.code.trim()}
                      >
                        <ShieldCheck data-icon="inline-start" />
                        Verify and enable
                      </Button>
                    </div>
                  </FieldGroup>
                </form>
              ) : totpFlow.kind === "recovery-codes" ? (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">Recovery codes</span>
                    <CopyButton value={totpFlow.codes.join("\n")} label="Copy recovery codes" />
                  </div>
                  <div className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-md border p-3 font-mono text-sm sm:grid-cols-2">
                    {totpFlow.codes.map((code) => (
                      <span key={code}>{code}</span>
                    ))}
                  </div>
                  <Button
                    type="button"
                    className="self-end"
                    onClick={() => setTOTPFlow({ kind: "idle" })}
                  >
                    Done
                  </Button>
                </div>
              ) : status.data.totpEnabled ? (
                <FieldGroup>
                  <div className="flex items-center gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md border">
                      <Smartphone className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">Authenticator enabled</div>
                      <div className="text-xs text-muted-foreground">
                        {status.data.recoveryCodesRemaining} recovery codes remaining
                      </div>
                    </div>
                  </div>
                  <Field>
                    <FieldLabel htmlFor="totp-management-code">
                      Authenticator or recovery code
                    </FieldLabel>
                    <Input
                      id="totp-management-code"
                      autoComplete="one-time-code"
                      value={verificationCode}
                      onChange={(event) => setVerificationCode(event.target.value)}
                      disabled={pendingAction !== null}
                    />
                  </Field>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pendingAction !== null || !verificationCode.trim()}
                      onClick={() => void handleRegenerateRecoveryCodes()}
                    >
                      <RefreshCw data-icon="inline-start" />
                      Replace recovery codes
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={pendingAction !== null || !verificationCode.trim()}
                      onClick={() => setDisableOpen(true)}
                    >
                      <Trash2 data-icon="inline-start" />
                      Disable
                    </Button>
                  </div>
                </FieldGroup>
              ) : (
                <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
                  <div className="flex size-10 items-center justify-center rounded-md border">
                    <Smartphone className="size-5" />
                  </div>
                  <div className="font-medium">No authenticator</div>
                  <Button
                    type="button"
                    disabled={pendingAction !== null}
                    onClick={() => void handleBeginTOTP()}
                  >
                    <ShieldCheck data-icon="inline-start" />
                    Set up authenticator
                  </Button>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={disableOpen}
        title="Disable authenticator"
        description="Password login will no longer require a second factor. Existing recovery codes will be deleted."
        confirmLabel="Disable"
        pending={pendingAction === "disable-totp"}
        variant="destructive"
        onOpenChange={setDisableOpen}
        onConfirm={handleDisableTOTP}
      />
    </>
  );
}
