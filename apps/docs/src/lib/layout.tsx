import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const repositoryUrl = "https://github.com/tarik02/aperture";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: "Aperture" },
    githubUrl: repositoryUrl,
    links: [{ text: "REST API", url: "/api-reference" }],
  };
}
