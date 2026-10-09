import { useState } from "react";
import * as Effect from "effect/Effect";
import { AuthApi } from "@aperture-browser/api-client";
import { useRunApi } from "@aperture-browser/session-react";
import { toast } from "sonner";
import { useAuthSessionStore } from "#/stores/auth-session.ts";

export function useTenantSelection() {
  const runApi = useRunApi();
  const [switching, setSwitching] = useState(false);

  async function selectTenant(tenantId: string | null, temporary = false) {
    const initial = useAuthSessionStore.getState();
    if (initial.auth === null) {
      return;
    }
    setSwitching(true);
    try {
      await runApi(
        AuthApi.use((api) =>
          temporary ? api.getTenantContext(tenantId) : api.getAuthMe(tenantId),
        ).pipe(
          Effect.match({
            onSuccess: (response) => {
              const current = useAuthSessionStore.getState();
              if (current.auth !== initial.auth) {
                return;
              }
              if (temporary && tenantId !== null) {
                current.setTemporaryAuthenticated(response);
              } else {
                current.setAuthenticated(response);
              }
            },
            onFailure: (error) => toast.error(error.message),
          }),
        ),
      );
    } finally {
      setSwitching(false);
    }
  }

  return { selectTenant, switching };
}
