import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { SessionsApi } from "@aperture-browser/api-client";
import { useTenantApi } from "#/hooks/use-tenant-api.ts";

const pollInterval = 5_000;

export const sessionFilesQueryKey = (tenantKey: string | null, sessionId: string) =>
  ["session-files", tenantKey, sessionId] as const;

/** Every file and directory of the session, polled while mounted and the page is visible. */
export function useSessionFilesQuery(sessionId: string) {
  const api = useTenantApi();

  return useQuery({
    queryKey: [...sessionFilesQueryKey(api.tenantKey, sessionId), "list"],
    queryFn: ({ signal }) =>
      api.run(
        (credentials) =>
          SessionsApi.use((sessions) => sessions.listSessionFiles(credentials, sessionId)),
        { signal },
      ),
    enabled: api.ready,
    // Stops once the listing fails so a broken connection is not hammered; focusing the
    // window or a mutation refetches it.
    refetchInterval: (query) => (query.state.status === "error" ? false : pollInterval),
    refetchOnWindowFocus: "always",
  });
}

function useInvalidateSessionFiles(sessionId: string) {
  const queryClient = useQueryClient();
  const { tenantKey } = useTenantApi();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: sessionFilesQueryKey(tenantKey, sessionId) }),
    [queryClient, sessionId, tenantKey],
  );
}

/** Uploads one file; the panel runs one per file so each shows its own pending row. */
export function useUploadSessionFileMutation(sessionId: string) {
  const api = useTenantApi();
  const invalidate = useInvalidateSessionFiles(sessionId);

  return useMutation({
    mutationFn: ({ file, directory }: { file: File; directory: string | undefined }) =>
      api.run((credentials) =>
        SessionsApi.use((sessions) =>
          sessions.uploadSessionFiles(
            credentials,
            sessionId,
            [{ name: file.name, content: file }],
            directory === undefined ? undefined : { directory },
          ),
        ),
      ),
    onSettled: invalidate,
  });
}

export function useCreateSessionDirectoryMutation(sessionId: string) {
  const api = useTenantApi();
  const invalidate = useInvalidateSessionFiles(sessionId);

  return useMutation({
    mutationFn: (relativePath: string) =>
      api.run((credentials) =>
        SessionsApi.use((sessions) =>
          sessions.createSessionDirectory(credentials, sessionId, relativePath),
        ),
      ),
    onSuccess: invalidate,
  });
}

export function useMoveSessionFileMutation(sessionId: string) {
  const api = useTenantApi();
  const invalidate = useInvalidateSessionFiles(sessionId);

  return useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      api.run((credentials) =>
        SessionsApi.use((sessions) => sessions.moveSessionFile(credentials, sessionId, input)),
      ),
    onSuccess: invalidate,
  });
}

export function useDeleteSessionFileMutation(sessionId: string) {
  const api = useTenantApi();
  const invalidate = useInvalidateSessionFiles(sessionId);

  return useMutation({
    mutationFn: ({ relativePath, recursive }: { relativePath: string; recursive: boolean }) =>
      api.run((credentials) =>
        SessionsApi.use((sessions) =>
          sessions.deleteSessionFile(credentials, sessionId, relativePath, { recursive }),
        ),
      ),
    onSuccess: invalidate,
  });
}

/** Asks for a signed URL and hands it to the browser as an attachment download. */
export function useDownloadSessionFile(sessionId: string) {
  const { run } = useTenantApi();

  return useCallback(
    async (relativePath: string, name: string) => {
      const { url } = await run((credentials) =>
        SessionsApi.use((sessions) =>
          sessions.createSessionFileDownloadURL(credentials, sessionId, {
            relativePath,
            disposition: "attachment",
          }),
        ),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    },
    [run, sessionId],
  );
}
