import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@aperture-browser/ui/components/combobox";
import { useSessionsQuery } from "#/features/session/session.queries.ts";
import { useSnapshotsQuery } from "#/features/snapshot/snapshot.queries.ts";
import { useWorkspacesQuery } from "#/features/workspace/workspace.queries.ts";

const KINDS = {
  workspaces: { group: "Workspaces", one: "Workspace" },
  sessions: { group: "Sessions", one: "Session" },
  snapshots: { group: "Snapshots", one: "Snapshot" },
} as const;
export type ResourceKind = keyof typeof KINDS;

/** One thing a token is held to. */
export type ChosenResource = { readonly kind: ResourceKind; readonly id: string };

type Option = ChosenResource & {
  /** The kind and the id together: what tells one option from every other. */
  readonly value: string;
  readonly label: string;
};

type Group = { readonly value: string; readonly items: ReadonlyArray<Option> };

const option = (kind: ResourceKind, id: string, label: string): Option => ({
  kind,
  id,
  label,
  value: `${kind}:${id}`,
});

type TokenResourcesPickerProps = {
  id: string;
  chosen: ReadonlyArray<ChosenResource>;
  invalid: boolean;
  onChange: (chosen: ReadonlyArray<ChosenResource>) => void;
};

/** Chooses the workspaces, sessions and snapshots a token reaches, among those there are. */
export function TokenResourcesPicker({ id, chosen, invalid, onChange }: TokenResourcesPickerProps) {
  const anchor = useComboboxAnchor();
  const workspaces = useWorkspacesQuery();
  const sessions = useSessionsQuery();
  const snapshots = useSnapshotsQuery();

  const groups: Group[] = [
    {
      value: KINDS.workspaces.group,
      items: (workspaces.data ?? []).map((one) => option("workspaces", one.id, one.name)),
    },
    {
      value: KINDS.sessions.group,
      items: (sessions.data ?? []).map((one) =>
        option("sessions", one.id, one.label ?? "Unlabelled session"),
      ),
    },
    {
      value: KINDS.snapshots.group,
      items: (snapshots.data ?? []).map((one) =>
        option("snapshots", one.id, one.name ?? "Unnamed snapshot"),
      ),
    },
  ];
  const options = groups.flatMap((group) => group.items);
  const selected = chosen.map(
    (one) =>
      options.find((each) => each.kind === one.kind && each.id === one.id) ??
      // What was chosen and is gone since is still told, by its id.
      option(one.kind, one.id, one.id),
  );
  const asking = workspaces.isPending || sessions.isPending || snapshots.isPending;

  return (
    <Combobox
      multiple
      autoHighlight
      items={groups}
      value={selected}
      itemToStringLabel={(one: Option) => `${one.label} ${one.id}`}
      itemToStringValue={(one: Option) => one.value}
      isItemEqualToValue={(one: Option, other: Option) => one.value === other.value}
      filter={(one: Option, sought: string) => {
        const lowered = sought.trim().toLowerCase();
        return one.label.toLowerCase().includes(lowered) || one.id.toLowerCase().includes(lowered);
      }}
      onValueChange={(next: Option[], details) => {
        // Escape closes the list; it does not take back what was chosen from it.
        if (details.reason === "escape-key") {
          details.allowPropagation();
          return;
        }
        onChange(next.map(({ kind, id }) => ({ kind, id })));
      }}
    >
      <ComboboxChips
        ref={anchor}
        data-console-token-resources
        title="A workspace stands for all the sessions and snapshots in it, those made later as well"
      >
        <ComboboxValue>
          {(values: Option[]) => (
            <>
              {values.map((one) => (
                <ComboboxChip key={one.value} data-console-token-resource-chosen={one.value}>
                  <span className="aperture:max-w-48 aperture:truncate">
                    {KINDS[one.kind].one}: {one.label}
                  </span>
                </ComboboxChip>
              ))}
              <ComboboxChipsInput
                id={id}
                aria-invalid={invalid}
                placeholder={
                  values.length === 0 ? "Search workspaces, sessions and snapshots" : undefined
                }
              />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>{asking ? "Asking for what there is…" : "Nothing found"}</ComboboxEmpty>
        <ComboboxList>
          {(group: Group) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(one: Option) => (
                  <ComboboxItem key={one.value} value={one} data-console-token-resource={one.value}>
                    <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col">
                      <span className="aperture:truncate">{one.label}</span>
                      <span className="aperture:truncate aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
                        {one.id}
                      </span>
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
