import { createFileRoute } from "@tanstack/react-router";
import { NotFound } from "#/components/not-found.tsx";

// Built as `404.html`, which is what an address with no page is answered with.
export const Route = createFileRoute("/404")({
  head: () => ({ meta: [{ title: "Page not found · Aperture" }] }),
  component: NotFound,
});
