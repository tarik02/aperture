export type TagFilterValue = Array<{
  key: string;
  operator: "eq" | "neq" | "in" | "not_in";
  values: string[];
}>;

/** Encodes tag filters as the parallel tagKey, tagOperator and tagValue query lists. */
export const tagQuery = (tags: TagFilterValue | undefined) => ({
  tagKey: tags?.map((tag) => tag.key),
  tagOperator: tags?.map((tag) => tag.operator),
  tagValue: tags?.map((tag) => tag.values.join(",")),
});

/** Drops empty strings and empty list items, which mean "no filter". */
export const compactQuery = <T extends object>(query: T): T =>
  Object.fromEntries(
    Object.entries(query).flatMap(([key, value]) => {
      if (value === undefined || value === null || value === "") return [];
      if (!Array.isArray(value)) return [[key, value]];
      const items = value.filter((item) => item !== "");
      return items.length > 0 ? [[key, items]] : [];
    }),
  ) as T;
