import { createFileRoute } from "@tanstack/react-router";
import { SessionWorkbench } from "#/components/workbench/session-workbench.tsx";

export const Route = createFileRoute("/")({
  component: WorkbenchPage,
});

function WorkbenchPage() {
  return <SessionWorkbench />;
}
