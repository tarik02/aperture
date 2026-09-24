import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent } from "@aperture/ui/components/dialog";
import { LoginForm } from "#/features/auth/login-form.tsx";
import { runApi } from "#/lib/runtime.ts";

type WelcomeLoginModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function WelcomeLoginModal({ open, onOpenChange }: WelcomeLoginModalProps) {
  const loginMethods = useQuery({
    queryKey: ["auth", "login-methods"],
    queryFn: ({ signal }) => runApi((api) => api.listLoginMethods(), { signal }),
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
