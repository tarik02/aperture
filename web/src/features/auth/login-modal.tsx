import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent } from "#/components/ui/dialog.tsx";
import { LoginForm } from "#/features/auth/login-form.tsx";
import { apiClient } from "#/lib/api/client.ts";

type WelcomeLoginModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function WelcomeLoginModal({ open, onOpenChange }: WelcomeLoginModalProps) {
  const loginMethods = useQuery({
    queryKey: ["auth", "login-methods"],
    queryFn: () => apiClient.listLoginMethods(),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <LoginForm loginMethods={loginMethods.data?.methods} onDone={() => undefined} />
      </DialogContent>
    </Dialog>
  );
}
