import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@aperture-browser/ui/components/dialog";
import { Field, FieldError } from "@aperture-browser/ui/components/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@aperture-browser/ui/components/item";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aperture-browser/ui/components/select";
import { useForm, useStore } from "@tanstack/react-form";
import { Building2, Trash2 } from "lucide-react";
import { useState } from "react";
import { Choice } from "#/components/choice.tsx";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { CopyButton } from "#/components/copy-button.tsx";
import { ListEmpty } from "#/components/list-empty.tsx";
import { ITEM_ROW, LinesSkeleton, WHOLE } from "#/components/list-skeleton.tsx";
import {
  type AccountWorkspace,
  useAccountWorkspacesQuery,
  usePlaceAccountMutation,
  useUnplaceAccountMutation,
} from "#/features/account/account-workspaces.ts";
import type { Account } from "#/features/account/account.queries.ts";
import { SignsInWith } from "#/features/account/signs-in-with.tsx";
import { useWorkspacesQuery } from "#/features/workspace/workspace.queries.ts";
import { told } from "#/lib/api.ts";
import { reveal } from "#/lib/reveal.ts";
import { useLast } from "#/lib/use-last.ts";
import { required } from "#/lib/validation.ts";
import { WORKSPACE_ROLES, type WorkspaceRole } from "#/lib/words.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function Fact({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="aperture:flex aperture:min-h-6 aperture:items-center aperture:text-muted-foreground">
        {name}
      </dt>
      <dd className="aperture:flex aperture:min-h-6 aperture:min-w-0 aperture:items-center aperture:gap-1">
        {children}
      </dd>
    </>
  );
}

type AccountSheetProps = {
  /** Whose it is; it stays as it was while it closes. */
  account: Account | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * One account, a person's or a service's, as an admin looks at it: what is known of it,
 * and the workspaces it is in, where it is let in and out and told what it does there.
 */
export function AccountSheet({ account, open, onOpenChange }: AccountSheetProps) {
  const shown = useLast(account);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent side="right">
        {shown === undefined ? null : <Shown key={shown.id} account={shown} open={open} />}
      </DialogContent>
    </Dialog>
  );
}

function Shown({ account, open }: { account: Account; open: boolean }) {
  const places = useAccountWorkspacesQuery(account.id, open);
  const workspaces = useWorkspacesQuery();
  const place = usePlaceAccountMutation(account.id);
  const unplace = useUnplaceAccountMutation(account.id);
  const [removing, setRemoving] = useState<AccountWorkspace>();
  const removed = useLast(removing);
  const inside = new Set(places.data?.map((one) => one.id));
  const outside = (workspaces.data ?? []).filter((workspace) => !inside.has(workspace.id));
  const form = useForm({
    defaultValues: { workspaceId: "", role: "member" as WorkspaceRole },
    onSubmit: async ({ value, formApi }) => {
      try {
        await place.mutateAsync(value);
      } catch {
        // The mutation tells of it.
        return;
      }
      formApi.reset();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{account.name}</DialogTitle>
        <DialogDescription>{account.email ?? "Service account"}</DialogDescription>
      </DialogHeader>
      <dl
        data-console-account-facts
        className="aperture:grid aperture:shrink-0 aperture:grid-cols-[auto_1fr] aperture:gap-x-4 aperture:gap-y-1.5 aperture:text-sm"
      >
        <Fact name="ID">
          <span
            data-console-account-id
            className="aperture:min-w-0 aperture:truncate aperture:font-mono aperture:text-xs"
          >
            {account.id}
          </span>
          <CopyButton value={account.id} label="Copy the ID" variant="ghost" size="icon-xs" />
        </Fact>
        <Fact name="Role">
          <Badge variant={account.admin ? "default" : "outline"}>
            {account.admin ? "Admin" : account.kind === "person" ? "Member" : "Service"}
          </Badge>
          {account.disabledAt === null ? null : <Badge variant="destructive">Disabled</Badge>}
        </Fact>
        {account.kind === "person" ? (
          <Fact name="Signs in with">
            <SignsInWith account={account} />
          </Fact>
        ) : null}
        <Fact name="Created">{when.format(new Date(account.createdAt.epochMilliseconds))}</Fact>
      </dl>

      <h3 className="aperture:shrink-0 aperture:pt-2 aperture:text-sm aperture:font-medium">
        Workspaces
      </h3>
      {/* Above the workspaces, so that it stays where it is as they come and go. */}
      <form
        data-console-account-place
        noValidate
        className="aperture:flex aperture:shrink-0 aperture:flex-wrap aperture:items-start aperture:gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="aperture:min-w-0 aperture:flex-1 aperture:max-sm:basis-full">
          <form.Field name="workspaceId" validators={{ onSubmit: required("A workspace") }}>
            {(field) => {
              const error = field.state.meta.errors.find((one) => typeof one === "string");
              return (
                <Field data-invalid={error === undefined ? undefined : true}>
                  <Select
                    items={outside.map((workspace) => ({
                      value: workspace.id,
                      label: workspace.name,
                    }))}
                    disabled={outside.length === 0}
                    value={field.state.value === "" ? null : field.state.value}
                    onValueChange={(next) => field.handleChange(next ?? "")}
                  >
                    <SelectTrigger
                      aria-label="Workspace to add to"
                      aria-invalid={error !== undefined}
                      data-console-account-place-workspace
                      className="aperture:w-full"
                    >
                      <SelectValue
                        placeholder={
                          workspaces.isSuccess && outside.length === 0
                            ? "In every workspace"
                            : "Add to a workspace"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {outside.map((workspace) => (
                          <SelectItem key={workspace.id} value={workspace.id}>
                            {workspace.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldError ref={reveal} reserved>
                    {error}
                  </FieldError>
                </Field>
              );
            }}
          </form.Field>
        </div>
        <form.Field name="role">
          {(field) => (
            <Choice
              aria-label="Role"
              value={field.state.value}
              options={WORKSPACE_ROLES}
              onChange={field.handleChange}
              className="aperture:max-sm:flex-1"
            />
          )}
        </form.Field>
        <Button type="submit" pending={submitting} disabled={outside.length === 0}>
          Add
        </Button>
      </form>
      {/* On a phone, four workspaces. */}
      <DialogBody height={`calc(4 * ${ITEM_ROW})`}>
        {places.isError ? (
          <p role="alert" className="aperture:text-sm aperture:text-destructive">
            {told(places.error)}
          </p>
        ) : places.isPending ? (
          <LinesSkeleton />
        ) : places.data.length === 0 ? (
          <ListEmpty icon={Building2} title="In no workspace yet" />
        ) : (
          <ItemGroup data-console-account-workspaces>
            {places.data.map((workspace) => (
              <Item
                key={workspace.id}
                role="listitem"
                variant="outline"
                size="xs"
                data-console-account-workspace={workspace.name}
              >
                <ItemContent className="aperture:min-w-0">
                  <ItemTitle className={WHOLE}>{workspace.name}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Choice
                    size="sm"
                    aria-label={`Role in ${workspace.name}`}
                    value={workspace.role}
                    options={WORKSPACE_ROLES}
                    onChange={(role) =>
                      role === workspace.role
                        ? undefined
                        : place.mutate({ workspaceId: workspace.id, role })
                    }
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove from ${workspace.name}`}
                    data-console-account-unplace
                    onClick={() => setRemoving(workspace)}
                  >
                    <Trash2 />
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </DialogBody>
      <ConfirmDialog
        open={removing !== undefined}
        title={`Remove ${account.name} from ${removed?.name ?? "this workspace"}?`}
        description="What is the workspace's stays the workspace's."
        confirmLabel="Remove"
        variant="destructive"
        pending={unplace.isPending}
        onOpenChange={(next) => (next ? undefined : setRemoving(undefined))}
        onConfirm={() =>
          removing === undefined
            ? undefined
            : unplace.mutate(removing.id, { onSettled: () => setRemoving(undefined) })
        }
      />
    </>
  );
}
