import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@aperture/ui/components/accordion";
import { Button } from "@aperture/ui/components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@aperture/ui/components/combobox";
import { Field, FieldGroup, FieldLabel } from "@aperture/ui/components/field";
import { Input } from "@aperture/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aperture/ui/components/select";
import { TagEditor } from "@aperture/ui/components/tag-editor";
import { Textarea } from "@aperture/ui/components/textarea";
import type { Connection } from "../connection.ts";
import { blankSnapshot, type Popup } from "./use-popup.ts";

/** The collapsible "Advanced" section of the teleport form. */
export function TeleportOptions({ popup, connection }: { popup: Popup; connection: Connection }) {
  const { draft, busy, actions } = popup;
  const snapshot = draft.destination === "snapshot";

  return (
    <Accordion
      value={draft.advanced ? ["advanced"] : []}
      onValueChange={(values) => actions.updateDraft({ advanced: values.includes("advanced") })}
    >
      <AccordionItem value="advanced" className="border-none">
        <AccordionTrigger disabled={busy}>Advanced</AccordionTrigger>
        <AccordionContent className="pt-2 pb-0">
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
            <Field>
              <FieldLabel htmlFor="browser-channel">Browser channel</FieldLabel>
              <Select
                items={connection.channels.map((channel) => ({ value: channel, label: channel }))}
                value={connection.channel}
                disabled={busy}
                onValueChange={(value) => void actions.changeChannel(value)}
              >
                <SelectTrigger id="browser-channel" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  <SelectGroup>
                    {connection.channels.map((channel) => (
                      <SelectItem key={channel} value={channel}>
                        {channel}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
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
  snapshots: string[];
  selected: string;
  disabled: boolean;
  onChange: (snapshot: string) => void;
}

function BaseSnapshotField({ snapshots, selected, disabled, onChange }: BaseSnapshotFieldProps) {
  const blank = selected === blankSnapshot;

  return (
    <Field>
      <FieldLabel htmlFor="base-snapshot">Start from snapshot</FieldLabel>
      <Combobox
        items={snapshots}
        value={blank ? null : selected}
        onValueChange={(value) => onChange(typeof value === "string" ? value : blankSnapshot)}
      >
        <ComboboxTrigger
          id="base-snapshot"
          render={
            <Button
              type="button"
              variant="outline"
              className="w-full min-w-0 justify-between"
              disabled={disabled}
            />
          }
        >
          <span className="min-w-0 truncate">{blank ? "Blank session" : selected}</span>
        </ComboboxTrigger>
        <ComboboxContent align="start" className="w-(--anchor-width) min-w-(--anchor-width)">
          <ComboboxInput placeholder="Search snapshots" showTrigger={false} className="w-auto" />
          {blank ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mx-1 mt-1 justify-start"
              onClick={() => onChange(blankSnapshot)}
            >
              Blank session
            </Button>
          )}
          <ComboboxEmpty>No snapshots found</ComboboxEmpty>
          <ComboboxList>
            {(snapshotName: string) => (
              <ComboboxItem key={snapshotName} value={snapshotName}>
                {snapshotName}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </Field>
  );
}
