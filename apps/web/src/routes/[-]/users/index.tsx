import { createFileRoute } from "@tanstack/react-router";
import { UserListPage } from "#/features/user/list-page/user-list-page.tsx";

export const Route = createFileRoute("/-/users/")({
  component: UserListPage,
});
