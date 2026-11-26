import {
  SETTINGS,
  type SettingKey,
  type SettingEffective,
  type SettingLevel,
  type SettingView,
  saidAt,
} from "@aperture-browser/control-api";
import { Button } from "@aperture-browser/ui/components/button";
import { ButtonGroup } from "@aperture-browser/ui/components/button-group";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@aperture-browser/ui/components/input-group";
import { Skeleton } from "@aperture-browser/ui/components/skeleton";
import { Toggle } from "@aperture-browser/ui/components/toggle";
import { ToggleGroup, ToggleGroupItem } from "@aperture-browser/ui/components/toggle-group";
import { cn } from "@aperture-browser/ui/utils";
import { CornerDownRight, Lock, Minus, Plus, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Choice } from "#/components/choice.tsx";
import {
  byWhom,
  factorOf,
  SETTING_GROUPS,
  SETTING_WORDS,
  SOURCE_WORDS,
  unitsOf,
  valueWords,
} from "#/features/settings/setting-words.ts";
import {
  type Amount,
  amountOf,
  beyondOf,
  boundsBelow,
  changes,
  choicesOf,
  type Draft,
  draftOf,
  entryOf,
  inheritedOf,
  inUnit,
  isChoice,
  type Mode,
  noneOverNode,
  tidy,
} from "#/features/settings/settings-draft.ts";
import {
  refusal,
  type SettingChange,
  type SettingsTarget,
  useSaveSettingsMutation,
  useSettingsQuery,
} from "#/features/settings/settings.queries.ts";
import { told } from "#/lib/api.ts";

/**
 * The settings of a level as they are edited: what each says now, with what was changed of
 * it and not saved yet, and why what was saved last was refused.
 */
export function useSettingsEditor(target: SettingsTarget) {
  const settings = useSettingsQuery(target);
  const save = useSaveSettingsMutation(target);
  const [drafts, setDrafts] = useState<Partial<Record<SettingKey, Draft>>>({});
  const [problems, setProblems] = useState<Partial<Record<SettingKey, string>>>({});
  const views = (settings.data ?? []).filter((setting) => saidAt(setting.key, target.level));
  const bounds = (setting: SettingView) => limitsBelow(setting, target.level);
  const changed = views.filter((setting) => {
    const draft = drafts[setting.key];
    return draft !== undefined && changes(setting, draft, bounds(setting), target.level);
  });

  const change = (setting: SettingView, update: (draft: Draft) => Draft) => {
    setDrafts((all) => ({
      ...all,
      [setting.key]: update(all[setting.key] ?? draftOf(setting, target.level)),
    }));
    setProblems(({ [setting.key]: _, ...rest }) => rest);
  };

  const discard = () => {
    setDrafts({});
    setProblems({});
  };

  const submit = () => {
    const said: Array<SettingChange> = [];
    const wrong: Partial<Record<SettingKey, string>> = {};
    for (const setting of changed) {
      const draft = drafts[setting.key];
      if (draft === undefined) {
        continue;
      }
      const made = entryOf(setting.key, draft, bounds(setting));
      const beyond = "problem" in made ? undefined : beyondOf(setting, made.entry, target.level);
      if ("problem" in made) {
        wrong[setting.key] = made.problem;
      } else if (beyond !== undefined) {
        wrong[setting.key] = beyond;
      } else {
        const empty = Object.keys(made.entry).length === 0;
        said.push({ key: setting.key, entry: empty ? null : made.entry });
      }
    }
    if (Object.keys(wrong).length > 0) {
      setProblems(wrong);
      return;
    }
    save.mutate(said, {
      onSuccess: (refused) => {
        setDrafts((all) =>
          Object.fromEntries(
            Object.entries(all).filter(([key]) => refused[key as SettingKey] !== undefined),
          ),
        );
        setProblems(
          Object.fromEntries(
            views.flatMap((setting) =>
              refused[setting.key] === undefined
                ? []
                : [[setting.key, refusal(refused[setting.key], setting, target.level)]],
            ),
          ),
        );
      },
    });
  };

  return {
    target,
    settings,
    views,
    drafts,
    problems,
    count: changed.length,
    saving: save.isPending,
    change,
    discard,
    submit,
  };
}

export type SettingsEditor = ReturnType<typeof useSettingsEditor>;

/** Whether the levels below say a setting, and the caller holds them to bounds of it. */
const limitsBelow = (setting: SettingView, level: SettingLevel) =>
  setting.bounds && boundsBelow(setting.key, level);

/** Where a stepper stops, in what the setting is counted in: what the levels above hold it to. */
type Ends = { readonly least?: number; readonly most?: number };

/** A number in a unit, typed or stepped by one, with the unit beside it. */
function AmountField({
  settingKey,
  value,
  onChange,
  disabled,
  steps,
  ends = {},
  prefix,
  placeholder,
  label,
  amountOf: part,
  invalid,
}: {
  settingKey: SettingKey;
  value: Amount;
  onChange: (value: Amount) => void;
  disabled: boolean;
  /** Whether it has buttons that step it; a bound, kept short, has a word before it instead. */
  steps: boolean;
  ends?: Ends;
  prefix?: string;
  placeholder?: string;
  /** The setting's title, which every control of it is named after. */
  label: string;
  /** Which of the setting's amounts it is, as the checks find it. */
  amountOf: "value" | "min" | "max";
  invalid?: boolean;
}) {
  const units = unitsOf(settingKey);
  const factor = factorOf(value.unit, units);
  const counts = SETTINGS[settingKey].type.kind === "count";
  const typed = Number(value.amount);
  const now = value.amount.trim() === "" || !Number.isFinite(typed) ? 0 : typed;
  const most = ends.most === undefined ? Number.POSITIVE_INFINITY : ends.most / factor;
  const least = Math.max(ends.least === undefined ? 0 : ends.least / factor, 0);
  const up = Math.min(now + 1, most);
  const down = Math.max(now - 1, least);
  // A count may be none; a time, a size or processors are more than none.
  const lowers = value.amount.trim() !== "" && down < now && (counts ? down >= 0 : down > 0);
  const named = part === "value" ? label : `${part === "min" ? "Least" : "Most"} below of ${label}`;
  return (
    <ButtonGroup className="aperture:w-full">
      {/* Its ring over the unit beside it, as the unit's is over it. */}
      <InputGroup className="aperture:min-w-0 aperture:flex-1 aperture:has-focus-visible:z-10">
        {steps ? (
          <InputGroupAddon>
            <InputGroupButton
              size="icon-xs"
              aria-label={`Less ${label}`}
              data-console-setting-step="less"
              disabled={disabled || !lowers}
              onClick={() => onChange({ ...value, amount: tidy(down) })}
            >
              <Minus />
            </InputGroupButton>
          </InputGroupAddon>
        ) : null}
        {prefix === undefined ? null : <InputGroupAddon>{prefix}</InputGroupAddon>}
        <InputGroupInput
          aria-label={named}
          data-console-setting-amount={part}
          inputMode="decimal"
          className={cn("aperture:tabular-nums", steps && "aperture:text-center")}
          disabled={disabled}
          placeholder={placeholder}
          aria-invalid={invalid}
          value={value.amount}
          onChange={(event) => onChange({ ...value, amount: event.target.value })}
        />
        {steps ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label={`More ${label}`}
              data-console-setting-step="more"
              disabled={disabled || !(up > now)}
              onClick={() => onChange({ ...value, amount: tidy(up) })}
            >
              <Plus />
            </InputGroupButton>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      {units.length > 0 ? (
        <Choice
          aria-label={`Unit of ${named}`}
          className="aperture:w-17 aperture:shrink-0"
          disabled={disabled}
          value={value.unit}
          options={units}
          onChange={(unit) => onChange(inUnit(settingKey, value, unit))}
        />
      ) : null}
    </ButtonGroup>
  );
}

/**
 * Where what a level inherits comes from, as its mode says it. To a person on their own
 * page, their level of no workspace says what they said there, or what an admin held them
 * to; the member level is never above them.
 */
const inheritedWords = (setting: SettingView, inherited: SettingEffective, at: SettingLevel) => {
  const { source, value } = inherited;
  if (!setting.bounds && source === "account") {
    const held = setting.above.max;
    return held !== null && held.level === "account" && held.value === value
      ? "admin"
      : "your account";
  }
  return setting.bounds && source === "account" && at === "member"
    ? "this person"
    : SOURCE_WORDS[source];
};

/** The few words under a setting that say what holds it, and why it was not saved. */
function notesOf(setting: SettingView, level: SettingLevel) {
  const { key, here, effective, above } = setting;
  const notes: Array<string> = [];
  const lockedAt =
    above.min !== null && above.max !== null && above.min.value === above.max.value
      ? above.min.level
      : above.allowed !== null && above.allowed.values.length === 1
        ? above.allowed.level
        : null;
  if (lockedAt !== null) {
    notes.push(`Locked by ${byWhom(setting, lockedAt, level)}`);
  } else {
    if (above.min !== null) {
      notes.push(
        `At least ${valueWords(key, above.min.value)} by ${byWhom(setting, above.min.level, level)}`,
      );
    }
    if (above.max !== null) {
      notes.push(
        `At most ${valueWords(key, above.max.value)} by ${byWhom(setting, above.max.level, level)}`,
      );
    }
    if (above.allowed !== null) {
      notes.push(
        `Only ${above.allowed.values.map((one) => valueWords(key, one)).join(", ")} by ${byWhom(setting, above.allowed.level, level)}`,
      );
    }
  }
  if (effective.clamped && here?.value !== undefined && effective.source !== "node") {
    notes.push(
      `Held to ${valueWords(key, effective.value)} by ${byWhom(setting, effective.source, level)}`,
    );
  }
  return { notes, locked: lockedAt !== null };
}

function SettingRow({
  editor,
  setting,
  boundsColumn,
}: {
  editor: SettingsEditor;
  setting: SettingView;
  /** Whether the rows leave room for what holds the levels below, so they line up. */
  boundsColumn: boolean;
}) {
  const { key, here } = setting;
  const words = SETTING_WORDS[key];
  const level = editor.target.level;
  const draft = editor.drafts[key] ?? draftOf(setting, level);
  const bounds = limitsBelow(setting, level);
  const edited = editor.drafts[key] !== undefined;
  const changed = edited && changes(setting, draft, bounds, level);
  const inherited = inheritedOf(setting);
  const { notes, locked } = notesOf(setting, level);
  // What the levels above do not let it be is said as it is typed, not only once it is saved.
  const made = changed ? entryOf(key, draft, bounds) : undefined;
  const beyond =
    made === undefined || "problem" in made ? undefined : beyondOf(setting, made.entry, level);
  const problem = editor.problems[key] ?? beyond;
  const disabled = !setting.changeable || editor.saving || (locked && here === null);
  const choice = isChoice(key);
  const choices = choicesOf(key);
  const { above } = setting;
  const allowedAbove = (one: string | boolean) =>
    above.allowed === null || above.allowed.values.includes(one);
  const choiceOptions = choices.map((one) => ({
    value: String(one),
    label: valueWords(key, one),
    disabled: !allowedAbove(one),
  }));
  const ends = { least: above.min?.value, most: above.max?.value };
  const update = (part: Partial<Draft>) => editor.change(setting, (old) => ({ ...old, ...part }));

  const modes: ReadonlyArray<{ value: Mode; label: string; disabled?: boolean }> = [
    {
      value: "inherit",
      label: `Inherit · ${inheritedWords(setting, inherited, level)}`,
    },
    { value: "set", label: "Override" },
    // Never and no limit are more than any most, and than each node's own.
    ...(!choice && words.none !== undefined
      ? [
          {
            value: "none" as const,
            label: words.none,
            disabled: above.max !== null || noneOverNode(setting, level),
          },
        ]
      : []),
    ...(bounds ? [{ value: "enforce" as const, label: "Enforce" }] : []),
  ];

  const value = (() => {
    // What is inherited is shown as it would be set: changing it overrides it.
    if (draft.mode === "inherit") {
      if (choice) {
        return (
          <Choice
            aria-label={words.label}
            className="aperture:w-full aperture:text-muted-foreground"
            disabled={disabled}
            value={String(inherited.value)}
            options={choiceOptions}
            onChange={(chosen) => update({ mode: "set", choice: chosen })}
          />
        );
      }
      if (typeof inherited.value === "number") {
        return (
          <AmountField
            settingKey={key}
            label={words.label}
            amountOf="value"
            steps
            ends={ends}
            disabled={disabled}
            value={amountOf(key, inherited.value)}
            onChange={(amount) => update({ mode: "set", value: amount })}
          />
        );
      }
    }
    // Of no number ("Forever", each node's own) the field is empty and says so; typing one sets it.
    if (!choice && (draft.mode === "inherit" || draft.mode === "none")) {
      return (
        <AmountField
          settingKey={key}
          label={words.label}
          amountOf="value"
          steps
          ends={ends}
          disabled={disabled}
          placeholder={
            draft.mode === "inherit" && inherited.source === "node"
              ? "Per node"
              : valueWords(key, null)
          }
          value={{ ...draft.value, amount: "" }}
          onChange={(amount) => update({ mode: "set", value: amount })}
        />
      );
    }
    return choice ? (
      <Choice
        aria-label={words.label}
        className="aperture:w-full"
        disabled={disabled}
        value={draft.choice}
        options={choiceOptions}
        onChange={(chosen) => update({ choice: chosen })}
      />
    ) : (
      <AmountField
        settingKey={key}
        label={words.label}
        amountOf="value"
        steps
        ends={ends}
        disabled={disabled}
        invalid={problem !== undefined}
        value={draft.value}
        onChange={(amount) => update({ value: amount })}
      />
    );
  })();

  const limiting = bounds && draft.limited && draft.mode !== "enforce";
  const grid = boundsColumn
    ? "aperture:grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)] aperture:sm:grid-cols-[2rem_11rem_13rem]"
    : "aperture:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] aperture:sm:grid-cols-[11rem_13rem]";

  return (
    <div
      data-console-setting={key}
      data-console-setting-changed={changed ? "" : undefined}
      className="aperture:flex aperture:flex-col aperture:gap-3 aperture:px-4 aperture:py-3.5 aperture:sm:flex-row aperture:sm:items-start aperture:sm:justify-between aperture:sm:gap-6"
    >
      <div className="aperture:flex aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:gap-0.5">
        <span className="aperture:flex aperture:items-center aperture:gap-2 aperture:text-sm aperture:font-medium">
          {words.label}
          {changed ? (
            <span
              role="img"
              aria-label="Changed"
              className="aperture:size-1.5 aperture:shrink-0 aperture:rounded-full aperture:bg-primary"
            />
          ) : null}
        </span>
        <span className="aperture:text-sm aperture:text-muted-foreground">{words.description}</span>
        {notes.length > 0 ? (
          <span
            data-console-setting-note
            className="aperture:mt-1 aperture:flex aperture:items-center aperture:gap-1.5 aperture:text-xs aperture:text-muted-foreground"
          >
            {locked ? <Lock className="aperture:size-3 aperture:shrink-0" /> : null}
            {notes.join(" · ")}
          </span>
        ) : null}
        {problem === undefined ? null : (
          <span
            role="alert"
            data-console-setting-problem
            className="aperture:mt-1 aperture:text-xs aperture:text-destructive"
          >
            {problem}
          </span>
        )}
      </div>
      <div className={cn("aperture:grid aperture:shrink-0 aperture:gap-2", grid)}>
        {boundsColumn ? (
          bounds ? (
            <Toggle
              aria-label={`Limit lower levels of ${words.label}`}
              className="aperture:text-muted-foreground aperture:aria-pressed:text-foreground"
              title="Limit lower levels"
              data-console-setting-limit
              disabled={disabled || draft.mode === "enforce"}
              pressed={limiting}
              onPressedChange={(pressed) => update({ limited: pressed })}
            >
              <SlidersHorizontal />
            </Toggle>
          ) : (
            <span />
          )
        ) : null}
        <Choice
          aria-label={`Mode of ${words.label}`}
          className="aperture:w-full"
          disabled={disabled}
          value={draft.mode}
          options={modes}
          onChange={(mode) => update({ mode })}
        />
        {value}
        {limiting ? (
          <>
            <CornerDownRight
              aria-hidden
              className="aperture:size-4 aperture:self-center aperture:justify-self-center aperture:text-muted-foreground"
            />
            {choice ? (
              <ToggleGroup
                multiple
                variant="outline"
                spacing={0}
                aria-label={`Allowed below of ${words.label}`}
                className="aperture:col-span-2 aperture:w-full"
                disabled={disabled}
                value={[...draft.allowed]}
                onValueChange={(allowed) => update({ allowed })}
              >
                {choices.map((one) => (
                  <ToggleGroupItem
                    key={String(one)}
                    value={String(one)}
                    data-console-setting-allowed={String(one)}
                    className="aperture:flex-1"
                    disabled={!allowedAbove(one)}
                  >
                    {valueWords(key, one)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : (
              (["min", "max"] as const).map((end) => {
                const held = above[end];
                return (
                  <AmountField
                    key={end}
                    settingKey={key}
                    label={words.label}
                    amountOf={end}
                    steps={false}
                    prefix={end}
                    placeholder={
                      held === null ? "any" : amountOf(key, held.value, draft[end].unit).amount
                    }
                    disabled={disabled}
                    invalid={problem !== undefined}
                    value={draft[end]}
                    onChange={(amount) => update({ [end]: amount })}
                  />
                );
              })
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function SectionsSkeleton() {
  return Array.from({ length: 2 }, (_, section) => (
    <section
      key={section}
      aria-hidden
      data-console-skeleton
      className="aperture:flex aperture:flex-col aperture:gap-2"
    >
      <Skeleton className="aperture:mx-1 aperture:h-4 aperture:w-24" />
      <div className="aperture:divide-y aperture:rounded-xl aperture:border aperture:bg-card">
        {Array.from({ length: 3 }, (_, row) => (
          <div
            key={row}
            className="aperture:flex aperture:items-center aperture:justify-between aperture:gap-6 aperture:px-4 aperture:py-3.5"
          >
            <div className="aperture:flex aperture:flex-col aperture:gap-1.5">
              <Skeleton className="aperture:h-4 aperture:w-40" />
              <Skeleton className="aperture:h-4 aperture:w-72 aperture:max-w-full" />
            </div>
            <Skeleton className="aperture:h-8 aperture:w-60 aperture:max-sm:hidden" />
          </div>
        ))}
      </div>
    </section>
  ));
}

/** A level's settings in their groups, a card of rows each, edited where they are. */
export function SettingsSections({ editor }: { editor: SettingsEditor }) {
  const { settings, views, target } = editor;
  const boundsColumn = views.some((setting) => limitsBelow(setting, target.level));
  if (settings.isError) {
    return (
      <p role="alert" className="aperture:text-sm aperture:text-destructive">
        {told(settings.error)}
      </p>
    );
  }
  return (
    <div
      data-console-settings={target.level}
      className="aperture:flex aperture:flex-col aperture:gap-6"
    >
      {settings.isPending ? <SectionsSkeleton /> : null}
      {SETTING_GROUPS.map((group) => {
        const shown = group.keys.flatMap((key) => views.filter((one) => one.key === key));
        return shown.length === 0 ? null : (
          <section
            key={group.title}
            data-console-settings-group={group.title}
            className="aperture:flex aperture:flex-col aperture:gap-2"
          >
            <h2 className="aperture:px-1 aperture:text-xs aperture:font-medium aperture:tracking-wide aperture:text-muted-foreground aperture:uppercase">
              {group.title}
            </h2>
            <div className="aperture:divide-y aperture:rounded-xl aperture:border aperture:bg-card aperture:text-card-foreground">
              {shown.map((setting) => (
                <SettingRow
                  key={setting.key}
                  editor={editor}
                  setting={setting}
                  boundsColumn={boundsColumn}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const unsaved = (count: number) => (count === 1 ? "1 unsaved change" : `${count} unsaved changes`);

/** What was changed and not saved, and the buttons that save it or forget it. */
export function SaveActions({ editor }: { editor: SettingsEditor }) {
  return (
    <>
      <span className="aperture:pl-1 aperture:text-sm aperture:whitespace-nowrap aperture:text-muted-foreground">
        {editor.count === 0 ? null : unsaved(editor.count)}
      </span>
      <div className="aperture:flex aperture:items-center aperture:gap-2">
        <Button
          size="sm"
          variant="ghost"
          data-console-settings-discard
          disabled={editor.count === 0 || editor.saving}
          onClick={editor.discard}
        >
          Discard
        </Button>
        <Button
          size="sm"
          data-console-settings-submit
          disabled={editor.count === 0}
          pending={editor.saving}
          onClick={editor.submit}
        >
          Save
        </Button>
      </div>
    </>
  );
}

/**
 * At the foot of a page, over the middle of what it shows, while anything is changed and
 * not saved.
 */
export function SaveBar({ editor }: { editor: SettingsEditor }) {
  if (editor.count === 0) {
    return null;
  }
  return (
    <div className="aperture:pointer-events-none aperture:absolute aperture:inset-x-3 aperture:bottom-5 aperture:z-40 aperture:flex aperture:justify-center">
      <div
        data-console-settings-save
        role="toolbar"
        aria-label="Unsaved changes"
        className="aperture:pointer-events-auto aperture:flex aperture:min-h-11 aperture:w-full aperture:max-w-md aperture:animate-in aperture:items-center aperture:justify-between aperture:gap-3 aperture:rounded-xl aperture:bg-popover aperture:py-1.5 aperture:pr-1.5 aperture:pl-3 aperture:text-popover-foreground aperture:shadow-lg aperture:ring-1 aperture:ring-foreground/10 aperture:duration-150 aperture:fade-in-0 aperture:slide-in-from-bottom-2"
      >
        <SaveActions editor={editor} />
      </div>
    </div>
  );
}
