import { createFileRoute } from "@tanstack/react-router";
import { TenantListPage } from "#/features/tenant/list-page/tenant-list-page.tsx";

export const Route = createFileRoute("/-/tenants/")({
  component: TenantListPage,
});
