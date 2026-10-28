/** A boolean search param. Search values arrive parsed as JSON, so `?embed=1` is the number 1. */
export function searchFlag(value: unknown): true | undefined {
  return value === true || value === 1 || value === "1" || value === "true" ? true : undefined;
}
