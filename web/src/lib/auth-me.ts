import { z } from "zod";

const tenantSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
});

const principalSchema = z.object({
  tokenId: z.string(),
  name: z.string(),
  authorityType: z.enum(["system_admin", "tenant"]),
  tenantId: z.string().nullable(),
  scopes: z.array(z.string()),
});

const authMeSchema = z.object({
  principal: principalSchema,
  selectedTenant: tenantSchema.nullable(),
});

const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type AuthMeResponse = z.infer<typeof authMeSchema>;
export type AuthMePrincipal = z.infer<typeof principalSchema>;
export type AuthMeTenant = z.infer<typeof tenantSchema>;

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
  }
}

export async function fetchAuthMe(
  token: string,
  selectedTenantId?: string | null,
): Promise<AuthMeResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.trim()}`,
    Accept: "application/json",
  };

  if (selectedTenantId) {
    headers["X-Aperture-Tenant-Id"] = selectedTenantId;
  }

  const response = await fetch("/api/auth/me", { headers });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    if (parsed.success) {
      throw new ApiRequestError(parsed.data.error.code, parsed.data.error.message, response.status);
    }

    throw new ApiRequestError("internal_error", "Request failed", response.status);
  }

  return authMeSchema.parse(body);
}

export async function fetchApiHealth(): Promise<"ok" | "error"> {
  try {
    const response = await fetch("/api/health", {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return "error";
    }

    const body: unknown = await response.json().catch(() => null);
    const parsed = z.object({ status: z.literal("ok") }).safeParse(body);
    return parsed.success ? "ok" : "error";
  } catch {
    return "error";
  }
}
