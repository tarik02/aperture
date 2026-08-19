import { apiClient } from "#/lib/api/client.ts";
import type { AuthMeResponse } from "#/lib/api/schemas.ts";

export async function fetchAuthMe(
  token: string | null,
  selectedTenantId?: string | null,
): Promise<AuthMeResponse> {
  return apiClient.getAuthMe(
    token
      ? {
          token,
          credentialType: "api_token",
          authorityType: null,
          tenantId: null,
          selectedTenantId: selectedTenantId ?? null,
          resourceMode: "all",
          resourceGrants: [],
        }
      : {
          credentialType: "web_session",
          authorityType: null,
          tenantId: null,
          selectedTenantId: selectedTenantId ?? null,
          resourceMode: "all",
          resourceGrants: [],
        },
  );
}

export async function fetchApiHealth(): Promise<"ok" | "error"> {
  try {
    await apiClient.getHealth();
    return "ok";
  } catch {
    return "error";
  }
}
