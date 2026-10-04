import { createFileRoute } from "@tanstack/react-router";
import { OAuthConsentPage } from "#/features/oauth/consent-page.tsx";

export const Route = createFileRoute("/oauth/consent")({
  component: OAuthConsentPage,
});
