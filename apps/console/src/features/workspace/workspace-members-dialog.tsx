import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { useForm, useStore } from "@tanstack/react-form";
import { Trash2 } from "lucide-react";
import { Choice } from "#/components/choice.tsx";
import { TextField } from "#/components/text-field.tsx";
import {
  useAdmitMemberMutation,
  useDismissMemberMutation,
  useWorkspaceMembersQuery,
  type Workspace,
} from "#/features/workspace/workspace.queries.ts";
import { required } from "#/lib/validation.ts";

const ROLES = [
  { value: "member", label: "member" },
  { value: "admin", label: "admin" },
] as const;
type Role = (typeof ROLES)[number]["value"];

type WorkspaceMembersDialogProps = {
  workspace: Workspace;
  /** Whether whoever looks says who is in the workspace. */
  administers: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Who is in a workspace, and for its admins, who is let in and out. */
export function WorkspaceMembersDialog({
  workspace,
  administers,
  open,
  onOpenChange,
}: WorkspaceMembersDialogProps) {
  const members = useWorkspaceMembersQuery(workspace.id, open);
  const admit = useAdmitMemberMutation(workspace.id);
  const dismiss = useDismissMemberMutation(workspace.id);
  const form = useForm({
    defaultValues: { accountId: "", role: "member" as Role },
    onSubmit: async ({ value, formApi }) => {
      try {
        await admit.mutateAsync({ accountId: value.accountId.trim(), role: value.role });
      } catch {
        // The mutation tells of it.
        return;
      }
      formApi.reset();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{workspace.name}</DialogTitle>
          <DialogDescription>Its members all have its sessions and snapshots.</DialogDescription>
        </DialogHeader>
        <ul data-console-members className="aperture:grid aperture:gap-2">
          {members.data?.map((member) => (
            <li
              key={member.accountId}
              className="aperture:flex aperture:items-center aperture:gap-2 aperture:text-sm"
            >
              <span className="aperture:grid aperture:min-w-0 aperture:flex-1">
                <span className="aperture:truncate aperture:font-medium">{member.name}</span>
                <span className="aperture:truncate aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
                  {member.accountId}
                </span>
              </span>
              <Badge variant={member.role === "admin" ? "default" : "outline"}>{member.role}</Badge>
              {administers ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${member.name}`}
                  disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate(member.accountId)}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {administers ? (
          <form
            data-console-member-add
            className="aperture:flex aperture:items-start aperture:gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <form.Field name="accountId" validators={{ onSubmit: required("An account id") }}>
              {(field) => (
                <TextField
                  field={field}
                  label="Account id"
                  placeholder="Account id"
                  autoComplete="off"
                  labelHidden
                />
              )}
            </form.Field>
            <form.Field name="role">
              {(field) => (
                <Choice
                  aria-label="Role"
                  value={field.state.value}
                  options={ROLES}
                  onChange={field.handleChange}
                />
              )}
            </form.Field>
            <Button type="submit" disabled={submitting}>
              Add
            </Button>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
