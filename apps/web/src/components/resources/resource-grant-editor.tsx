import { useMemo } from "react";
import { Button } from "@aperture-browser/ui/components/button";
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
import { Field, FieldLabel } from "@aperture-browser/ui/components/field";
import { useSessionsInfiniteQuery } from "#/features/session/session.queries.ts";
import { useSnapshotsInfiniteQuery } from "#/features/snapshot/snapshot.queries.ts";
import type { ApiCredentials, ResourceGrant } from "@aperture-browser/api-client";
import { flattenInfinitePages } from "@aperture-browser/api-client";

type ResourceGrantEditorProps = {
  id: string;
  label: string;
  grants: ResourceGrant[];
  credentials: ApiCredentials | null;
  disabled?: boolean;
  onChange: (grants: ResourceGrant[]) => void;
};

type ResourceOption = {
  value: string;
  label: string;
  detail: string;
  resourceType: "session" | "snapshot";
  resourceId: string;
};

type ResourceOptionGroup = {
  value: string;
  items: ResourceOption[];
};

export function ResourceGrantEditor({
  id,
  label,
  grants,
  credentials,
  disabled,
  onChange,
}: ResourceGrantEditorProps) {
  const anchor = useComboboxAnchor();
  const sessionsQuery = useSessionsInfiniteQuery(
    { limit: 100 },
    { credentials, enabled: credentials !== null },
  );
  const snapshotsQuery = useSnapshotsInfiniteQuery(
    { limit: 100 },
    { credentials, enabled: credentials !== null },
  );
  const sessions = useMemo(
    () => flattenInfinitePages(sessionsQuery.data?.pages),
    [sessionsQuery.data?.pages],
  );
  const snapshots = useMemo(
    () => flattenInfinitePages(snapshotsQuery.data?.pages),
    [snapshotsQuery.data?.pages],
  );
  const groups = useMemo<ResourceOptionGroup[]>(
    () => [
      {
        value: "Sessions",
        items: sessions.map((session) => ({
          value: `session:${session.id}`,
          label: session.label?.trim() || "Untitled session",
          detail: `${session.status} · ${session.id}`,
          resourceType: "session",
          resourceId: session.id,
        })),
      },
      {
        value: "Snapshots",
        items: snapshots.map((snapshot) => ({
          value: `snapshot:${snapshot.id}`,
          label: snapshot.name,
          detail: snapshot.id,
          resourceType: "snapshot",
          resourceId: snapshot.id,
        })),
      },
    ],
    [sessions, snapshots],
  );
  const options = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const selectedOptions = useMemo(
    () =>
      grants.map(
        (grant) =>
          options.find(
            (option) =>
              option.resourceType === grant.resourceType && option.resourceId === grant.resourceId,
          ) ?? {
            value: `${grant.resourceType}:${grant.resourceId}`,
            label: grant.resourceId,
            detail: grant.resourceId,
            resourceType: grant.resourceType,
            resourceId: grant.resourceId,
          },
      ),
    [grants, options],
  );
  const loading = sessionsQuery.isLoading || snapshotsQuery.isLoading;
  const failed = sessionsQuery.isError || snapshotsQuery.isError;
  const loadingMore = sessionsQuery.isFetchingNextPage || snapshotsQuery.isFetchingNextPage;
  const hasMore = sessionsQuery.hasNextPage || snapshotsQuery.hasNextPage;

  return (
    <Field data-disabled={disabled || credentials === null ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Combobox
        multiple
        autoHighlight
        items={groups}
        value={selectedOptions}
        itemToStringLabel={(option: ResourceOption) => `${option.label} ${option.resourceId}`}
        itemToStringValue={(option: ResourceOption) => option.value}
        isItemEqualToValue={(option: ResourceOption, value: ResourceOption) =>
          option.value === value.value
        }
        filter={(option: ResourceOption, query: string) => {
          const normalizedQuery = query.trim().toLowerCase();
          return (
            option.label.toLowerCase().includes(normalizedQuery) ||
            option.resourceId.toLowerCase().includes(normalizedQuery)
          );
        }}
        onValueChange={(nextOptions: ResourceOption[]) =>
          onChange(
            nextOptions.map((option) => ({
              resourceType: option.resourceType,
              resourceId: option.resourceId,
            })),
          )
        }
        disabled={disabled || credentials === null}
      >
        <ComboboxChips ref={anchor}>
          <ComboboxValue>
            {(values) => (
              <>
                {values.map((option: ResourceOption) => (
                  <ComboboxChip key={option.value}>
                    <span className="aperture:max-w-48 aperture:truncate">
                      {option.resourceType === "session" ? "Session" : "Snapshot"}: {option.label}
                    </span>
                  </ComboboxChip>
                ))}
                <ComboboxChipsInput
                  id={id}
                  placeholder={values.length === 0 ? "Search sessions and snapshots" : undefined}
                  disabled={disabled || credentials === null}
                />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>
            {credentials === null
              ? "Select a tenant first"
              : loading
                ? "Loading resources..."
                : failed
                  ? "Failed to load resources"
                  : "No resources found"}
          </ComboboxEmpty>
          <ComboboxList>
            {(group: ResourceOptionGroup) => (
              <ComboboxGroup key={group.value} items={group.items}>
                <ComboboxLabel>{group.value}</ComboboxLabel>
                <ComboboxCollection>
                  {(option: ResourceOption) => (
                    <ComboboxItem key={option.value} value={option}>
                      <span className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col">
                        <span className="aperture:truncate">{option.label}</span>
                        <span className="aperture:truncate aperture:font-mono aperture:text-xs aperture:text-muted-foreground">
                          {option.detail}
                        </span>
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
            )}
          </ComboboxList>
          {hasMore ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="aperture:m-1 aperture:w-[calc(100%-0.5rem)]"
              onClick={() => {
                if (sessionsQuery.hasNextPage) {
                  void sessionsQuery.fetchNextPage();
                }
                if (snapshotsQuery.hasNextPage) {
                  void snapshotsQuery.fetchNextPage();
                }
              }}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading..." : "Load more resources"}
            </Button>
          ) : null}
        </ComboboxContent>
      </Combobox>
    </Field>
  );
}
