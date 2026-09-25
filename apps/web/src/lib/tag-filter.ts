export const tagFilterOperators = [
  { value: "eq", label: "=" },
  { value: "neq", label: "!=" },
  { value: "in", label: "in" },
  { value: "not_in", label: "not in" },
] as const;

export type TagFilterOperator = (typeof tagFilterOperators)[number]["value"];

export type TagFilterCondition = {
  key: string;
  operator: TagFilterOperator;
  values: string[];
};

export type TagFilterValue = TagFilterCondition[];

export function tagFilterOperatorLabel(operator: TagFilterOperator) {
  switch (operator) {
    case "eq":
      return "=";
    case "neq":
      return "!=";
    case "in":
      return "in";
    case "not_in":
      return "not in";
  }
}
