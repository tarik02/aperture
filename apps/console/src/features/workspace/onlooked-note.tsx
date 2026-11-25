import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@aperture-browser/ui/components/alert";
import { Button } from "@aperture-browser/ui/components/button";
import { Eye, LogIn } from "lucide-react";
import { useAccess } from "#/features/auth/access.ts";
import {
  useJoinWorkspaceMutation,
  useSelectedWorkspace,
} from "#/features/workspace/workspace.queries.ts";

/**
 * Said above what a workspace the admin is not in has: they see it, and act in it once
 * they join it.
 */
export function OnlookedNote() {
  const workspace = useSelectedWorkspace();
  const joins = useAccess().may("workspaces:write");
  const join = useJoinWorkspaceMutation();
  if (workspace === null || workspace.role !== null) {
    return null;
  }
  return (
    <Alert role="status" data-console-onlooked-note>
      <Eye />
      <AlertTitle>Not a member · read only</AlertTitle>
      <AlertDescription>Join the workspace to act in it.</AlertDescription>
      {joins ? (
        <AlertAction>
          <Button
            size="sm"
            variant="outline"
            data-console-workspace-join
            disabled={join.isPending}
            onClick={() => join.mutate(workspace.id)}
          >
            <LogIn />
            Join
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
