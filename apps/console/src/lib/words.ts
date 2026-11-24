/**
 * What is said of a failure as one sentence, however whoever answered worded it: it starts
 * with a capital and ends with a full stop, as everything the console says of failures does.
 */
export const sentence = (said: string) => {
  const text = said.trim();
  if (text === "") {
    return text;
  }
  const started = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?…]$/u.test(started) ? started : `${started}.`;
};

/**
 * A word of the API's as a label says it: its first letter a capital, and what it is
 * written with in place of spaces taken for them. What is an identifier, as a scope is,
 * is shown as it is written and not through this.
 */
export const worded = (word: string) => {
  const text = word.replaceAll(/[_-]+/gu, " ").trim();
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
};

/** What an account does in a workspace, as it is chosen and shown. */
export const WORKSPACE_ROLES = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]["value"];
