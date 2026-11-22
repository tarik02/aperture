import type { Named, Plan, Step } from "./plan.ts";

const said = (step: Step) => {
  switch (step.kind) {
    case "user":
      return step.joins === null
        ? `person ${step.name} <${step.email}>${step.admin ? ", an admin" : ""}${step.disabledAt === null ? "" : ", disabled"}: sets a password with a setup link`
        : `person ${step.name} <${step.email}>: is the account v2 has for that address, which stays as it is`;
    case "tenant-service":
    case "admin-service":
      return `service account ${step.name}${step.admin ? ", an admin" : ""}`;
    case "tenant":
      return `workspace ${step.name}`;
    case "member":
      return `${step.label}, as ${step.role}`;
    case "snapshot":
      return `snapshot ${step.name}${step.tenant === null ? ", its owner's own" : ""}`;
    case "token":
      return `token ${step.name}, anew: ${step.scopes.join(" ")}${step.snapshots === null ? "" : `, held to ${step.snapshots.length} snapshots`}`;
  }
};

const named = (lines: ReadonlyArray<Named>) =>
  lines.map((line) => `  ${line.what} ${line.label}: ${line.reason}`);

/** A plan as whoever runs the program reads it. */
export const render = (plan: Plan): string =>
  [
    `to move: ${plan.steps.length}`,
    ...plan.steps.map((step) => `  ${said(step)}`),
    `moved before: ${plan.moved}`,
    `left in v1: ${plan.skipped.length}`,
    ...named(plan.skipped),
    `in the way: ${plan.conflicts.length}`,
    ...named(plan.conflicts),
  ].join("\n");
