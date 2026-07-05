import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { ScrollArea } from "#/components/ui/scroll-area.tsx";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "#/components/ui/combobox.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import {
  tagFilterOperators,
  type TagFilterCondition,
  type TagFilterOperator,
  type TagFilterValue,
} from "#/lib/tag-filter.ts";
import { cn } from "#/lib/utils.ts";

type TagFilterProps = {
  value?: TagFilterValue;
  availableTags: Array<Record<string, string>>;
  onChange: (value?: TagFilterValue) => void;
};

const defaultOperator: TagFilterOperator = "eq";

export function TagFilter({ value, availableTags, onChange }: TagFilterProps) {
  const [conditions, setConditions] = useState<TagFilterValue>(() => ensureDraftRows(value ?? []));
  const [openValueIndex, setOpenValueIndex] = useState<number | null>(null);

  const tagIndex = useMemo(() => {
    const keys = new Set<string>();
    const valuesByKey = new Map<string, Set<string>>();

    for (const tags of availableTags) {
      for (const [key, tagValue] of Object.entries(tags)) {
        keys.add(key);
        const indexedValues = valuesByKey.get(key) ?? new Set<string>();
        indexedValues.add(tagValue);
        valuesByKey.set(key, indexedValues);
      }
    }

    return {
      keys: Array.from(keys).sort(),
      valuesByKey,
    };
  }, [availableTags]);

  const valueKey = serializeConditions(value ?? []);

  useEffect(() => {
    setConditions(ensureDraftRows(value ?? []));
  }, [valueKey]);

  useEffect(() => {
    const nextValue = completedConditions(conditions);
    if (serializeConditions(nextValue) === valueKey) {
      return;
    }
    onChange(nextValue.length > 0 ? nextValue : undefined);
  }, [conditions, onChange, valueKey]);

  function updateCondition(index: number, patch: Partial<TagFilterCondition>) {
    setConditions((current) =>
      ensureDraftRows(
        current.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)),
      ),
    );
  }

  function updateKey(index: number, key: string) {
    updateCondition(index, { key, values: [] });
    setOpenValueIndex(key ? index : null);
  }

  function updateOperator(index: number, rawOperator: unknown) {
    const operator = resolveOperator(rawOperator);
    if (!operator) {
      return;
    }
    setConditions((current) =>
      ensureDraftRows(
        current.map((condition, i) =>
          i === index
            ? {
                ...condition,
                operator,
                values: operatorAllowsMany(operator)
                  ? condition.values
                  : condition.values.slice(0, 1),
              }
            : condition,
        ),
      ),
    );
  }

  function updateSingleValue(index: number, value: string) {
    updateCondition(index, { values: value ? [value] : [] });
  }

  function addMultiValue(index: number, value: string) {
    setConditions((current) =>
      ensureDraftRows(
        current.map((condition, i) =>
          i === index && value && !condition.values.includes(value)
            ? { ...condition, values: [...condition.values, value] }
            : condition,
        ),
      ),
    );
  }

  function removeMultiValue(index: number, value: string) {
    updateCondition(index, {
      values: conditions[index]?.values.filter((item) => item !== value) ?? [],
    });
  }

  function removeCondition(index: number) {
    setConditions((current) => ensureDraftRows(current.filter((_, i) => i !== index)));
  }

  return (
    <ScrollArea scrollbars="horizontal" className="max-w-full min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        {conditions.map((condition, index) => {
          const valuesForKey = Array.from(tagIndex.valuesByKey.get(condition.key) ?? []).sort();
          const many = operatorAllowsMany(condition.operator);

          return (
            <div key={index} className="flex shrink-0 items-center gap-1.5">
              <DropdownStringCombobox
                ariaLabel="Tag key"
                placeholder="Tag"
                searchPlaceholder="Search keys"
                value={condition.key}
                options={tagIndex.keys}
                className="w-32"
                onChange={(key) => updateKey(index, key)}
              />
              {condition.key ? (
                <>
                  <Select
                    items={tagFilterOperators}
                    value={condition.operator}
                    onValueChange={(operator) => updateOperator(index, operator)}
                  >
                    <SelectTrigger size="sm" className="w-16">
                      <SelectValue>
                        {(selectedValue: unknown) =>
                          tagFilterOperators.find((item) => item.value === selectedValue)?.label ??
                          "="
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent align="start" className="min-w-24">
                      <SelectGroup>
                        {tagFilterOperators.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <DropdownStringCombobox
                    ariaLabel="Tag value"
                    placeholder={many ? "Add value" : "Value"}
                    searchPlaceholder="Search values"
                    value={many ? "" : (condition.values[0] ?? "")}
                    options={valuesForKey.filter((item) => !condition.values.includes(item))}
                    className="w-36"
                    open={openValueIndex === index}
                    onOpenChange={(open) =>
                      setOpenValueIndex((current) => {
                        if (open) {
                          return index;
                        }
                        return current === index ? null : current;
                      })
                    }
                    onChange={(value) =>
                      many ? addMultiValue(index, value) : updateSingleValue(index, value)
                    }
                  />
                  {many
                    ? condition.values.map((tagValue) => (
                        <Badge key={tagValue} variant="secondary" className="max-w-28 font-normal">
                          <span className="truncate">{tagValue}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${tagValue}`}
                            className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg:not([class*='size-'])]:size-3"
                            onClick={() => removeMultiValue(index, tagValue)}
                          >
                            <X />
                          </button>
                        </Badge>
                      ))
                    : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove tag condition"
                    onClick={() => removeCondition(index)}
                  >
                    <X />
                  </Button>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

type DropdownStringComboboxProps = {
  ariaLabel: string;
  value: string;
  options: string[];
  placeholder: string;
  searchPlaceholder: string;
  className: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onChange: (value: string) => void;
};

function DropdownStringCombobox({
  ariaLabel,
  value,
  options,
  placeholder,
  searchPlaceholder,
  className,
  open,
  onOpenChange,
  onChange,
}: DropdownStringComboboxProps) {
  function handleValueChange(nextValue: string | null) {
    if (typeof nextValue === "string") {
      onChange(nextValue);
    }
  }

  return (
    <Combobox
      items={options}
      value={value || null}
      open={open}
      onOpenChange={(nextOpen) => onOpenChange?.(nextOpen)}
      onValueChange={handleValueChange}
    >
      <ComboboxTrigger
        aria-label={ariaLabel}
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("min-w-0 justify-between", className)}
          />
        }
      >
        <span className={cn("min-w-0 truncate", !value && "text-muted-foreground")}>
          {value || placeholder}
        </span>
      </ComboboxTrigger>
      <ComboboxContent align="start" className="w-56">
        <ComboboxInput
          placeholder={searchPlaceholder}
          showTrigger={false}
          className="w-auto"
          autoFocus={open === true}
        />
        <ComboboxEmpty>No matches</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function completedConditions(conditions: TagFilterValue): TagFilterValue {
  return conditions
    .map((condition) => ({
      key: condition.key.trim(),
      operator: condition.operator,
      values: condition.values.map((value) => value.trim()).filter(Boolean),
    }))
    .filter((condition) => condition.key && condition.values.length > 0);
}

function ensureDraftRows(conditions: TagFilterValue): TagFilterValue {
  const rows = conditions.length > 0 ? conditions : [emptyCondition()];
  const withoutExtraEmpty = rows.filter((condition, index) => {
    if (condition.key || condition.values.length > 0) {
      return true;
    }
    return index === rows.length - 1;
  });
  const last = withoutExtraEmpty[withoutExtraEmpty.length - 1] ?? emptyCondition();
  return conditionComplete(last) ? [...withoutExtraEmpty, emptyCondition()] : withoutExtraEmpty;
}

function conditionComplete(condition: TagFilterCondition) {
  return Boolean(condition.key.trim() && condition.values.some((value) => value.trim()));
}

function emptyCondition(): TagFilterCondition {
  return { key: "", operator: defaultOperator, values: [] };
}

function serializeConditions(conditions: TagFilterValue) {
  return JSON.stringify(completedConditions(conditions));
}

function operatorAllowsMany(operator: TagFilterOperator) {
  return operator === "in" || operator === "not_in";
}

function resolveOperator(value: unknown): TagFilterOperator | null {
  switch (value) {
    case "eq":
    case "neq":
    case "in":
    case "not_in":
      return value;
    default:
      return null;
  }
}
