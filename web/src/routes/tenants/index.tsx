import { createFileRoute } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { PagePlaceholder } from "#/components/page-placeholder.tsx";

export const Route = createFileRoute("/tenants/")({
  component: TenantsPage,
});

function TenantsPage() {
  return <PagePlaceholder title="Tenants" icon={Building2} />;
}
