import { createFileRoute } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { PagePlaceholder } from "#/components/page-placeholder.tsx";

export const Route = createFileRoute("/tokens/")({
  component: TokensPage,
});

function TokensPage() {
  return <PagePlaceholder title="Tokens" icon={KeyRound} />;
}
