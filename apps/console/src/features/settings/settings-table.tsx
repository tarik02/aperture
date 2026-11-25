import { type SettingKey, saidAt } from "@aperture-browser/control-api";
import { Badge } from "@aperture-browser/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aperture-browser/ui/components/table";
import { Eraser, Lock, Pencil } from "lucide-react";
import { useState } from "react";
import { TableRowsSkeleton } from "#/components/list-skeleton.tsx";
import { type RowAction, RowActions, RowContextMenu } from "#/components/row-actions.tsx";
import { SettingDialog } from "#/features/settings/setting-dialog.tsx";
import { SETTING_WORDS, sourceWords, valueWords } from "#/features/settings/setting-words.ts";
import {
  type SettingsTarget,
  type SettingView,
  useClearSettingMutation,
  useSettingsQuery,
} from "#/features/settings/settings.queries.ts";
import { told } from "#/lib/api.ts";

/** What a level says of a setting, in a few words: its value and its bounds. */
const hereWords = (setting: SettingView) => {
  const { key, here } = setting;
  if (here === null) {
    return null;
  }
  const said = [
    here.value === undefined ? null : valueWords(key, here.value),
    here.min !== undefined && here.min === here.max
      ? "locked"
      : [
          here.min === undefined ? null : `≥ ${valueWords(key, here.min)}`,
          here.max === undefined ? null : `≤ ${valueWords(key, here.max)}`,
        ]
          .filter((one) => one !== null)
          .join(", ") || null,
    here.allowed === undefined
      ? null
      : `only ${here.allowed.map((one) => valueWords(key, one)).join(", ")}`,
  ];
  return said.filter((one) => one !== null).join(" · ");
};

function SettingRow({ target, setting }: { target: SettingsTarget; setting: SettingView }) {
  const [editing, setEditing] = useState(false);
  const clear = useClearSettingMutation(target);
  const { key, effective } = setting;
  const said = hereWords(setting);
  const actions: ReadonlyArray<RowAction> = setting.changeable
    ? [
        {
          key: "edit",
          label: "Edit",
          icon: Pencil,
          shown: "icon",
          onSelect: () => setEditing(true),
        },
        {
          key: "clear",
          label: "Clear",
          icon: Eraser,
          disabled: setting.here === null || clear.isPending,
          onSelect: () => clear.mutate(key),
        },
      ]
    : [];

  return (
    <RowContextMenu actions={actions}>
      <TableRow data-console-setting={key}>
        <TableCell className="aperture:font-medium">{SETTING_WORDS[key].label}</TableCell>
        <TableCell data-console-setting-effective>
          <span className="aperture:flex aperture:flex-wrap aperture:items-center aperture:gap-1.5">
            {effective.source === "node" ? "Each node's own" : valueWords(key, effective.value)}
            {effective.source === "node" ? null : (
              <Badge variant="outline" className="aperture:text-muted-foreground">
                {effective.locked ? <Lock /> : null}
                {sourceWords(effective)}
              </Badge>
            )}
          </span>
        </TableCell>
        <TableCell label="Said here" className="aperture:text-muted-foreground">
          {said ?? "—"}
        </TableCell>
        <TableCell>
          <RowActions actions={actions} label="Setting actions" />
          {setting.changeable ? (
            <SettingDialog
              target={target}
              setting={setting}
              open={editing}
              onOpenChange={setEditing}
            />
          ) : null}
        </TableCell>
      </TableRow>
    </RowContextMenu>
  );
}

/**
 * The settings as a level has them: what each comes to there and where from, and what the
 * level itself says, for whoever changes that to change.
 */
export function SettingsTable({
  target,
  keys,
}: {
  target: SettingsTarget;
  /** The settings shown; those the level says, without. */
  keys?: ReadonlyArray<SettingKey>;
}) {
  const settings = useSettingsQuery(target);
  if (settings.isError) {
    return (
      <p role="alert" className="aperture:text-sm aperture:text-destructive">
        {told(settings.error)}
      </p>
    );
  }
  const shown = (settings.data ?? []).filter((setting) =>
    keys === undefined ? saidAt(setting.key, target.level) : keys.includes(setting.key),
  );
  return (
    <Table stickyActionColumn data-console-settings={target.level}>
      <TableHeader>
        <TableRow>
          <TableHead>Setting</TableHead>
          <TableHead>Effective</TableHead>
          <TableHead>Said here</TableHead>
          <TableHead className="aperture:w-px" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {settings.isPending ? <TableRowsSkeleton columns={4} actions /> : null}
        {shown.map((setting) => (
          <SettingRow key={setting.key} target={target} setting={setting} />
        ))}
      </TableBody>
    </Table>
  );
}
