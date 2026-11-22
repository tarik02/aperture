type Rule = (field: { value: string }) => string | undefined;

/** What a field's rules say of what was typed: a sentence for whoever typed it, or nothing. */
export const required =
  (what: string): Rule =>
  ({ value }) =>
    value.trim() === "" ? `${what} is required.` : undefined;

export const email: Rule = ({ value }) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim()) ? undefined : "Enter an email address.";

export const atLeast =
  (length: number, what: string): Rule =>
  ({ value }) =>
    value.length < length ? `${what} is at least ${length} characters.` : undefined;

/** The first thing any of the rules says. */
export const all =
  (...rules: ReadonlyArray<Rule>): Rule =>
  (field) =>
    rules.map((rule) => rule(field)).find((said) => said !== undefined);
