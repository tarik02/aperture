import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import { createFileRoute } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "#/lib/layout.tsx";

export const Route = createFileRoute("/api-reference")({
  ssr: false,
  head: () => ({ meta: [{ title: "REST API · Aperture" }] }),
  component: ApiReference,
});

function ApiReference() {
  return (
    <HomeLayout {...baseOptions()}>
      <ApiReferenceReact
        configuration={{
          url: "/openapi.json",
          withDefaultFonts: false,
          showDeveloperTools: "never",
          agent: { disabled: true },
          mcp: { disabled: true },
          hideClientButton: true,
        }}
      />
    </HomeLayout>
  );
}
