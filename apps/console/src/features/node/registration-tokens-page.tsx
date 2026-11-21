import { Button } from "@aperture-browser/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";
import { Plus } from "lucide-react";
import { useState } from "react";
import { NameDialog } from "#/components/name-dialog.tsx";
import { LongName } from "#/components/long-name.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { SecretDialog } from "#/components/secret-dialog.tsx";
import { TablePage } from "#/components/table-page.tsx";
import { useCreateRegistrationTokenMutation } from "#/features/node/node.mutations.ts";
import { useRegistrationTokensQuery } from "#/features/node/node.queries.ts";
import { told } from "#/lib/api.ts";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** The tokens that let nodes register with this control plane. */
export function RegistrationTokensPage() {
  const tokens = useRegistrationTokensQuery();
  const create = useCreateRegistrationTokenMutation();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string>();

  return (
    <TablePage>
      <PageHeaderActions>
        <Button data-console-registration-token-new size="sm" onClick={() => setCreating(true)}>
          <Plus />
          New token
        </Button>
      </PageHeaderActions>
      {tokens.isError ? (
        <p role="alert" className="aperture:text-sm aperture:text-destructive">
          {told(tokens.error)}
        </p>
      ) : tokens.data?.length === 0 ? (
        <p
          data-console-empty
          className="aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
        >
          No registration tokens yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.data?.map((token) => (
              <TableRow key={token.id} data-console-registration-token={token.name}>
                <TableCell className="aperture:font-medium">
                  <LongName>{token.name}</LongName>
                </TableCell>
                <TableCell label="Created" className="aperture:text-muted-foreground">
                  {when.format(new Date(token.createdAt.epochMilliseconds))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <NameDialog
        title="New registration token"
        open={creating}
        onOpenChange={setCreating}
        onSubmit={async (name) => setSecret((await create.mutateAsync(name)).token)}
      />
      <SecretDialog
        title="Registration token"
        secret={secret}
        onClose={() => setSecret(undefined)}
      />
    </TablePage>
  );
}
