import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@aperture-browser/ui/components/combobox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Field, FieldError } from "@aperture-browser/ui/components/field";
import { useForm, useStore } from "@tanstack/react-form";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Choice } from "#/components/choice.tsx";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { TextField } from "#/components/text-field.tsx";
import { type Account, useAccountsQuery } from "#/features/account/account.queries.ts";
import { useAccountQuery } from "#/features/auth/auth.queries.ts";
import {
  useAdmitMemberMutation,
  useDismissMemberMutation,
  useWorkspaceMembersQuery,
  type Workspace,
} from "#/features/workspace/workspace.queries.ts";
import { reveal } from "#/lib/reveal.ts";
import { useLast } from "#/lib/use-last.ts";
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

/** Who is in a workspace, and for its admins, who is let in and out and as what. */
export function WorkspaceMembersDialog({
  workspace,
  administers,
  open,
  onOpenChange,
}: WorkspaceMembersDialogProps) {
  const own = useAccountQuery();
  const members = useWorkspaceMembersQuery(workspace.id, open);
  // Whom there is to let in is an admin's to list: anyone else names an account by its id.
  const lists = administers && own.data?.admin === true;
  const accounts = useAccountsQuery(open && lists);
  const admit = useAdmitMemberMutation(workspace.id);
  const dismiss = useDismissMemberMutation(workspace.id);
  const [removing, setRemoving] = useState<{ accountId: string; name: string }>();
  const removed = useLast(removing);
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
  const inside = new Set(members.data?.map((member) => member.accountId));
  const outside = (accounts.data ?? []).filter(
    (account) => !inside.has(account.id) && account.disabledAt === null,
  );
  const known = new Map(accounts.data?.map((account) => [account.id, account]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="aperture:sm:max-w-lg" height="28rem">
        <DialogHeader>
          <DialogTitle>{workspace.name}</DialogTitle>
        </DialogHeader>
        {/* Above the members, so that it stays where it is as they come and go. */}
        {administers ? (
          <form
            data-console-member-add
            noValidate
            className="aperture:flex aperture:shrink-0 aperture:flex-wrap aperture:items-start aperture:gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <div className="aperture:min-w-0 aperture:flex-1 aperture:max-sm:basis-full">
              <form.Field
                name="accountId"
                validators={{ onSubmit: required(lists ? "Someone to add" : "An account id") }}
              >
                {(field) =>
                  lists ? (
                    <AccountPicker
                      accounts={outside}
                      asking={accounts.isPending}
                      value={field.state.value}
                      error={field.state.meta.errors.find((error) => typeof error === "string")}
                      onChange={field.handleChange}
                    />
                  ) : (
                    <TextField
                      field={field}
                      label="Account id"
                      placeholder="Account id"
                      autoComplete="off"
                      labelHidden
                    />
                  )
                }
              </form.Field>
            </div>
            <form.Field name="role">
              {(field) => (
                <Choice
                  aria-label="Role"
                  value={field.state.value}
                  options={ROLES}
                  onChange={field.handleChange}
                  className="aperture:max-sm:flex-1"
                />
              )}
            </form.Field>
            <Button type="submit" disabled={submitting}>
              Add
            </Button>
          </form>
        ) : null}
        <DialogBody>
          <ul data-console-members className="aperture:grid aperture:gap-2">
            {members.data?.map((member) => (
              <li
                key={member.accountId}
                data-console-member={member.name}
                className="aperture:flex aperture:items-center aperture:gap-2 aperture:text-sm"
              >
                <span className="aperture:grid aperture:min-w-0 aperture:flex-1">
                  <span className="aperture:font-medium aperture:wrap-anywhere">{member.name}</span>
                  <span className="aperture:text-xs aperture:text-muted-foreground aperture:wrap-anywhere">
                    {known.get(member.accountId)?.email ?? (
                      <span className="aperture:font-mono">{member.accountId}</span>
                    )}
                  </span>
                </span>
                {administers ? (
                  <>
                    <Choice
                      size="sm"
                      aria-label={`Role of ${member.name}`}
                      value={member.role}
                      options={ROLES}
                      onChange={(role) =>
                        role === member.role
                          ? undefined
                          : admit.mutate({ accountId: member.accountId, role })
                      }
                    />
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove ${member.name}`}
                      onClick={() => setRemoving(member)}
                    >
                      <Trash2 />
                    </Button>
                  </>
                ) : (
                  <Badge variant={member.role === "admin" ? "default" : "outline"}>
                    {member.role}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </DialogBody>
        <ConfirmDialog
          open={removing !== undefined}
          title={`Remove ${removed?.name ?? "this member"}?`}
          description="What is the workspace's stays the workspace's."
          confirmLabel="Remove"
          variant="destructive"
          pending={dismiss.isPending}
          onOpenChange={(next) => (next ? undefined : setRemoving(undefined))}
          onConfirm={() =>
            removing === undefined
              ? undefined
              : dismiss.mutate(removing.accountId, { onSettled: () => setRemoving(undefined) })
          }
        />
      </DialogContent>
    </Dialog>
  );
}

type AccountPickerProps = {
  accounts: ReadonlyArray<Account>;
  asking: boolean;
  /** The id of the account that is chosen; empty for none. */
  value: string;
  error: string | undefined;
  onChange: (accountId: string) => void;
};

/** Chooses an account among those there are, by its name or its email address. */
function AccountPicker({ accounts, asking, value, error, onChange }: AccountPickerProps) {
  const chosen = accounts.find((account) => account.id === value) ?? null;
  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <Combobox
        autoHighlight
        items={accounts}
        value={chosen}
        itemToStringLabel={(account: Account) => account.name}
        itemToStringValue={(account: Account) => account.id}
        isItemEqualToValue={(one: Account, other: Account) => one.id === other.id}
        filter={(account: Account, sought: string) => {
          const lowered = sought.trim().toLowerCase();
          return [account.name, account.email ?? "", account.id].some((text) =>
            text.toLowerCase().includes(lowered),
          );
        }}
        onValueChange={(next: Account | null, details) => {
          // Escape closes the list; it does not take back who was chosen from it.
          if (details.reason === "escape-key") {
            details.allowPropagation();
            return;
          }
          onChange(next?.id ?? "");
        }}
      >
        <ComboboxInput
          aria-label="Who to add"
          aria-invalid={error !== undefined}
          placeholder="Name or email"
          autoComplete="off"
          className="aperture:w-full"
        />
        <ComboboxContent>
          <ComboboxEmpty>{asking ? "Asking who there is…" : "Nobody found"}</ComboboxEmpty>
          <ComboboxList>
            {(account: Account) => (
              <ComboboxItem key={account.id} value={account} data-console-member-option>
                <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col">
                  <span className="aperture:truncate">{account.name}</span>
                  <span className="aperture:truncate aperture:text-xs aperture:text-muted-foreground">
                    {account.email ?? "Service account"}
                  </span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <FieldError ref={reveal}>{error}</FieldError>
    </Field>
  );
}
