import type { Named, Plan, Step } from "./plan.ts";

const said = (step: Step) => {
  switch (step.kind) {
    case "person":
      return `person ${step.name} <${step.email}>${step.admin ? ", an admin" : ""}${step.disabledAt === null ? "" : ", disabled"}: ${step.password === null ? "sets a password with a setup link" : "signs in with their password of v1"}${step.secondFactor === null ? "" : ", and their second factor"}`;
    case "bearer":
      return `service account ${step.name}${step.admin ? ", an admin" : ""}: the bearer of the tokens moved`;
    case "workspace":
      return `workspace ${step.name}`;
    case "member":
      return `${step.label}, as ${step.role}`;
    case "snapshot":
      return `snapshot ${step.name}, ${step.workspaceId === null ? "its owner's own" : "its workspace's"}`;
    case "session":
      return `session ${step.label ?? step.id}, ${step.workspaceId === null ? "its owner's own" : "its workspace's"}, suspended${step.wasRunning ? ": it ran when v1 stopped, and is as its browser left it" : ""}`;
    case "token":
      return `token ${step.name}, ${step.digest === null ? "anew" : "as it was"}: ${step.scopes.join(" ")}${step.resources === null ? "" : `, held to ${step.resources.sessions.length} sessions and ${step.resources.snapshots.length} snapshots`}`;
  }
};

const named = (lines: ReadonlyArray<Named>) =>
  lines.map((line) => `  ${line.what} ${line.label}: ${line.reason}`);

/** A plan as whoever runs the program reads it. */
export const render = (plan: Plan): string =>
  [
    `to move: ${plan.steps.length}`,
    ...plan.steps.map((step) => `  ${said(step)}`),
    `in v2 already: ${plan.moved}`,
    `left in v1: ${plan.skipped.length}`,
    ...named(plan.skipped),
    `moved, and not quite what it was: ${plan.notes.length}`,
    ...named(plan.notes),
    `in the way: ${plan.conflicts.length}`,
    ...named(plan.conflicts),
  ].join("\n");
