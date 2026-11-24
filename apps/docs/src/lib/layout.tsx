import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { repositoryUrl } from "./pages.ts";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: "Aperture" },
    githubUrl: repositoryUrl,
    links: [{ text: "REST API", url: "/api-reference" }],
  };
}
