import { z } from "zod";

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

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

export function parseApiErrorBody(body: unknown): ApiErrorBody["error"] | null {
  const parsed = apiErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.error : null;
}
