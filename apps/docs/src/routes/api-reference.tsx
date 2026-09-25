import { createFileRoute } from "@tanstack/react-router";
import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "#/lib/layout";
import spec from "../../../../api/openapi.yaml?raw";

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
          content: spec,
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
