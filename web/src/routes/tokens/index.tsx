import { createFileRoute } from "@tanstack/react-router";
import { TokenListPage } from "#/features/token/list-page/token-list-page.tsx";

export const Route = createFileRoute("/tokens/")({
  component: TokenListPage,
});
