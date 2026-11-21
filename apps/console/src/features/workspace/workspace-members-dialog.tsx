import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Input } from "@aperture-browser/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@aperture-browser/ui/components/native-select";
import { Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  useAdmitMemberMutation,
  useDismissMemberMutation,
  useWorkspaceMembersQuery,
  type Workspace,
} from "#/features/workspace/workspace.queries.ts";

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
  const [accountId, setAccountId] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    admit.mutate({ accountId: accountId.trim(), role }, { onSuccess: () => setAccountId("") });
  };

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
          <form onSubmit={submit} className="aperture:flex aperture:gap-2">
            <Input
              name="account"
              placeholder="Account id"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            />
            <NativeSelect
              aria-label="Role"
              value={role}
              onChange={(event) => setRole(event.target.value as "member" | "admin")}
            >
              <NativeSelectOption value="member">member</NativeSelectOption>
              <NativeSelectOption value="admin">admin</NativeSelectOption>
            </NativeSelect>
            <Button type="submit" disabled={admit.isPending || accountId.trim() === ""}>
              Add
            </Button>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
