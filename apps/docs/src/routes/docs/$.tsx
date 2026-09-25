import { Suspense, use } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  EditOnGitHub,
} from "fumadocs-ui/layouts/docs/page";
import { useMDXComponents } from "#/components/mdx";
import { baseOptions, repositoryUrl } from "#/lib/layout";
import { docs, source } from "#/lib/source";

export const Route = createFileRoute("/docs/$")({
  component: Page,
  loader: async ({ params }) => {
    const page = source.getPage(params._splat?.split("/") ?? []);
    if (!page) throw notFound();
    await docs.getPage(page.path)?.preload();
    return {
      path: page.path,
      pageTree: await source.serializePageTree(source.getPageTree()),
    };
  },
});

function Content({ path }: { path: string }) {
  const page = docs.getPage(path);
  if (!page) throw notFound();
  const { toc } = use(page.load());
  const Body = page.body;

  return (
    <DocsPage toc={toc}>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>
      <DocsBody>
        <Body components={useMDXComponents()} />
      </DocsBody>
      <EditOnGitHub href={`${repositoryUrl}/blob/master/apps/docs/content/docs/${path}`} />
    </DocsPage>
  );
}

function Page() {
  const { path, pageTree } = useFumadocsLoader(Route.useLoaderData());
  return (
    <DocsLayout {...baseOptions()} tree={pageTree} githubUrl={repositoryUrl}>
      <Suspense>
        <Content path={path} />
      </Suspense>
    </DocsLayout>
  );
}
