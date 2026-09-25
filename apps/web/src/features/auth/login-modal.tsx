import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent } from "@aperture-browser/ui/components/dialog";
import { LoginForm } from "#/features/auth/login-form.tsx";
import { AuthApi } from "@aperture-browser/api-client";
import { useRunApi } from "#/lib/effect/react.tsx";

interface WelcomeLoginModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WelcomeLoginModal({ open, onOpenChange }: WelcomeLoginModalProps) {
  const runApi = useRunApi();
  const loginMethods = useQuery({
    queryKey: ["auth", "login-methods"],
    queryFn: ({ signal }) =>
      runApi(
        AuthApi.use((auth) => auth.listLoginMethods()),
        { signal },
      ),
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
