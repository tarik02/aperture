import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@aperture-browser/ui/components/accordion";
import { Button } from "@aperture-browser/ui/components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@aperture-browser/ui/components/combobox";
import { Field, FieldGroup, FieldLabel } from "@aperture-browser/ui/components/field";
import { Input } from "@aperture-browser/ui/components/input";
import { TagEditor } from "@aperture-browser/ui/components/tag-editor";
import { Textarea } from "@aperture-browser/ui/components/textarea";
import type { BaseSnapshot } from "../connection.ts";
import { blankSnapshot, type Popup } from "./use-popup.ts";

/** The collapsible "Advanced" section of the teleport form. */
export function TeleportOptions({ popup }: { popup: Popup }) {
  const { draft, busy, actions } = popup;
  const snapshot = draft.destination === "snapshot";

  return (
    <Accordion
      value={draft.advanced ? ["advanced"] : []}
      onValueChange={(values) => actions.updateDraft({ advanced: values.includes("advanced") })}
    >
      <AccordionItem value="advanced" className="aperture:border-none">
        <AccordionTrigger disabled={busy}>Advanced</AccordionTrigger>
        <AccordionContent className="aperture:pt-2 aperture:pb-0">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="resource-name">
                {snapshot ? "Snapshot name" : "Session name"}
              </FieldLabel>
              <Input
                id="resource-name"
                value={draft.resourceName}
                placeholder={snapshot ? "Required" : "Optional"}
                required={snapshot}
                disabled={busy}
                onChange={(event) => actions.updateDraft({ resourceName: event.target.value })}
              />
            </Field>
            {snapshot ? (
              <Field>
                <FieldLabel htmlFor="snapshot-description">Description</FieldLabel>
                <Textarea
                  id="snapshot-description"
                  value={draft.description}
                  placeholder="Optional"
                  disabled={busy}
                  onChange={(event) => actions.updateDraft({ description: event.target.value })}
                />
              </Field>
            ) : null}
            <TagEditor
              entries={draft.tags}
              onChange={(tags) => actions.updateDraft({ tags })}
              disabled={busy}
            />
            {popup.snapshots === null ? null : (
              <BaseSnapshotField
                snapshots={popup.snapshots}
                selected={draft.selectedSnapshot}
                disabled={busy}
                onChange={(selectedSnapshot) => actions.updateDraft({ selectedSnapshot })}
              />
            )}
          </FieldGroup>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

interface BaseSnapshotFieldProps {
  snapshots: BaseSnapshot[];
  selected: string;
  disabled: boolean;
  onChange: (snapshot: string) => void;
}

function BaseSnapshotField({ snapshots, selected, disabled, onChange }: BaseSnapshotFieldProps) {
  const chosen = snapshots.find(({ id }) => id === selected) ?? null;
  const blank = chosen === null;

  return (
    <Field>
      <FieldLabel htmlFor="base-snapshot">Start from snapshot</FieldLabel>
      <Combobox
        items={snapshots}
        value={chosen}
        itemToStringLabel={(snapshot: BaseSnapshot) => snapshot.name}
        isItemEqualToValue={(one: BaseSnapshot, other: BaseSnapshot) => one.id === other.id}
        onValueChange={(value) => onChange(value?.id ?? blankSnapshot)}
      >
        <ComboboxTrigger
          id="base-snapshot"
          render={
            <Button
              type="button"
              variant="outline"
              className="aperture:w-full aperture:min-w-0 aperture:justify-between"
              disabled={disabled}
            />
          }
        >
          <span className="aperture:min-w-0 aperture:truncate">
            {chosen?.name ?? "Blank session"}
          </span>
        </ComboboxTrigger>
        <ComboboxContent
          align="start"
          className="aperture:w-(--anchor-width) aperture:min-w-(--anchor-width)"
        >
          <ComboboxInput
            placeholder="Search snapshots"
            showTrigger={false}
            className="aperture:w-auto"
          />
          {blank ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="aperture:mx-1 aperture:mt-1 aperture:justify-start"
              onClick={() => onChange(blankSnapshot)}
            >
              Blank session
            </Button>
          )}
          <ComboboxEmpty>No snapshots found</ComboboxEmpty>
          <ComboboxList>
            {(snapshot: BaseSnapshot) => (
              <ComboboxItem key={snapshot.id} value={snapshot}>
                {snapshot.name}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </Field>
  );
}
