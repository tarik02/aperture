import { Badge } from "@aperture-browser/ui/components/badge";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@aperture-browser/ui/components/item";
import { ScrollArea } from "@aperture-browser/ui/components/scroll-area";
import { KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "#/components/confirm-dialog.tsx";
import { ListEmpty } from "#/components/list-empty.tsx";
import { LinesSkeleton, WHOLE } from "#/components/list-skeleton.tsx";
import { PageHeaderActions } from "#/components/page-header-actions.tsx";
import { useRemovePasskeyMutation } from "#/features/auth/auth.mutations.ts";
import { usePasskeysQuery, usePersonQuery } from "#/features/auth/auth.queries.ts";
import { PasskeyNameDialog } from "#/features/auth/passkey-name-dialog.tsx";
import {
  type SecondFactorDoing,
  SecondFactorDialog,
} from "#/features/auth/second-factor-dialog.tsx";
import { told } from "#/lib/api.ts";
import { type Passkey, passkeysSupported } from "#/lib/identity.ts";
import { useLast } from "#/lib/use-last.ts";

const added = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * How a person signs in beside their password. Their second factor, which is on or off and
 * is no list: it is turned on with an authenticator that is shown to have the secret, and
 * turned off, each with the password. And their passkeys, which are the page's list: added,
 * named anew and removed.
 */
export function SecurityPage() {
  const person = usePersonQuery();
  const passkeys = usePasskeysQuery(person.data !== null && person.data !== undefined);
  const remove = useRemovePasskeyMutation();
  const [doing, setDoing] = useState<SecondFactorDoing>();
  const done = useLast(doing);
  /** A passkey that is named: the one there is, or one that is added under the name. */
  const [naming, setNaming] = useState<{ passkey?: Passkey }>();
  const named = useLast(naming);
  const [removing, setRemoving] = useState<Passkey>();
  const removed = useLast(removing);

  if (person.data === null || person.data === undefined) {
    return person.isPending ? null : (
      <p
        data-console-not-allowed="security"
        className="aperture:px-4 aperture:py-16 aperture:text-center aperture:text-sm aperture:text-muted-foreground"
      >
        This is for whoever signs in as a person.
      </p>
    );
  }
  const secondFactor = person.data.secondFactor;
  const add = (
    <Button
      size="sm"
      data-console-passkey-add
      disabled={!passkeysSupported()}
      onClick={() => setNaming({})}
    >
      <Plus />
      Add a passkey
    </Button>
  );

  return (
    <ScrollArea className="aperture:h-full" viewportClassName="aperture:p-3">
      <PageHeaderActions>{add}</PageHeaderActions>
      <div
        data-console-security-page
        className="aperture:flex aperture:max-w-2xl aperture:flex-col aperture:gap-6"
      >
        <Item variant="outline" data-console-second-factor-row>
          <ItemMedia variant="icon">
            <ShieldCheck />
          </ItemMedia>
          <ItemContent className="aperture:min-w-0">
            <ItemTitle>
              Two-factor sign-in
              <Badge
                data-console-second-factor={secondFactor ? "on" : "off"}
                variant={secondFactor ? "default" : "outline"}
              >
                {secondFactor ? "On" : "Off"}
              </Badge>
            </ItemTitle>
            <ItemDescription className={WHOLE}>
              A code of an authenticator's after the password.
            </ItemDescription>
          </ItemContent>
          <ItemActions className="aperture:max-sm:basis-full">
            {secondFactor ? (
              <Button
                size="sm"
                variant="outline"
                data-console-renew-backup-codes
                className="aperture:max-sm:flex-1"
                onClick={() => setDoing("renew")}
              >
                New backup codes
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              data-console-second-factor-change
              className="aperture:max-sm:flex-1"
              onClick={() => setDoing(secondFactor ? "off" : "on")}
            >
              {secondFactor ? "Turn off" : "Turn on"}
            </Button>
          </ItemActions>
        </Item>

        <section className="aperture:flex aperture:flex-col aperture:gap-2">
          <h2 className="aperture:text-sm aperture:font-medium">Passkeys</h2>
          {passkeys.isError ? (
            <p role="alert" className="aperture:text-sm aperture:text-destructive">
              {told(passkeys.error)}
            </p>
          ) : passkeys.isPending ? (
            <LinesSkeleton lines={2} />
          ) : passkeys.data.length === 0 ? (
            <div
              data-console-passkeys-none
              className="aperture:flex aperture:rounded-lg aperture:border aperture:border-dashed"
            >
              <ListEmpty icon={KeyRound} title="No passkeys yet">
                {add}
              </ListEmpty>
            </div>
          ) : (
            <ItemGroup data-console-passkeys>
              {passkeys.data.map((passkey) => (
                <Item
                  key={passkey.id}
                  role="listitem"
                  variant="outline"
                  size="xs"
                  data-console-passkey={passkey.name}
                >
                  <ItemContent className="aperture:min-w-0">
                    <ItemTitle className={WHOLE}>{passkey.name}</ItemTitle>
                    {passkey.createdAt === undefined ? null : (
                      <ItemDescription className={WHOLE}>
                        Added {added.format(passkey.createdAt)}
                      </ItemDescription>
                    )}
                  </ItemContent>
                  <ItemActions className="aperture:gap-1">
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      data-console-passkey-rename
                      aria-label={`Rename ${passkey.name}`}
                      onClick={() => setNaming({ passkey })}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      data-console-passkey-remove
                      aria-label={`Remove ${passkey.name}`}
                      onClick={() => setRemoving(passkey)}
                    >
                      <Trash2 />
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
        </section>
      </div>
      <SecondFactorDialog
        person={person.data}
        doing={done ?? "on"}
        open={doing !== undefined}
        onOpenChange={(open) => (open ? undefined : setDoing(undefined))}
      />
      <PasskeyNameDialog
        passkey={named?.passkey}
        open={naming !== undefined}
        onOpenChange={(open) => (open ? undefined : setNaming(undefined))}
      />
      <ConfirmDialog
        open={removing !== undefined}
        title={`Remove ${removed?.name ?? "this passkey"}?`}
        description="Nobody signs in with it after."
        confirmLabel="Remove"
        variant="destructive"
        pending={remove.isPending}
        onOpenChange={(open) => (open ? undefined : setRemoving(undefined))}
        onConfirm={() =>
          removing === undefined
            ? undefined
            : remove.mutate(removing.id, { onSettled: () => setRemoving(undefined) })
        }
      />
    </ScrollArea>
  );
}
