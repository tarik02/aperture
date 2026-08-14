import { toast } from "sonner";
import { fetchAuthMe } from "#/lib/auth-me.ts";
import type { AuthMeResponse } from "#/lib/api/schemas.ts";
import type { TokenProfile } from "#/stores/token-vault.ts";

type BootstrapActions = {
  applyBootstrap: (profileId: string, response: AuthMeResponse) => void;
  clearBootstrapMetadata: (profileId: string) => void;
  touchProfile: (profileId: string) => void;
};

export async function bootstrapTokenProfile({
  profile,
  applyBootstrap,
  clearBootstrapMetadata,
  touchProfile,
}: BootstrapActions & { profile: TokenProfile }): Promise<boolean> {
  try {
    const selectedTenantId =
      profile.authorityType === "system_admin" ? profile.selectedTenantId : null;
    const response = await fetchAuthMe(profile.rawToken, selectedTenantId);
    applyBootstrap(profile.id, response);
    touchProfile(profile.id);
    return true;
  } catch {
    clearBootstrapMetadata(profile.id);
    toast.error("Token validation failed");
    return false;
  }
}
