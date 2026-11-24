import { createFileRoute, notFound } from "@tanstack/react-router";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBody, DocsPage, DocsTitle, EditOnGitHub } from "fumadocs-ui/layouts/docs/page";
import { Suspense, use } from "react";
import { useMDXComponents } from "#/components/mdx.tsx";
import { baseOptions } from "#/lib/layout.tsx";
import { pages, repositoryUrl } from "#/lib/pages.ts";
import { files, source } from "#/lib/source.ts";

export const Route = createFileRoute("/$")({
  component: Page,
  loader: async ({ params }) => {
    const slug = params._splat?.replace(/\/+$/, "") ?? "";
    const page = pages.find((page) => page.slug === slug);
    const file = page && files.get(page.file);
    if (!file) throw notFound();
    await file.preload();
    return {
      file: page.file,
      title: file.title,
      pageTree: await source.serializePageTree(source.getPageTree()),
    };
  },
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.title} · Aperture` }] : [],
  }),
});

function Content({ file }: { file: string }) {
  const page = files.get(file);
  if (!page) throw notFound();
  const { toc } = use(page.load());
  const Body = page.body;

  return (
    <DocsPage toc={toc}>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsBody>
        <Body components={useMDXComponents()} />
      </DocsBody>
      <EditOnGitHub href={`${repositoryUrl}/blob/master/${file}`} />
    </DocsPage>
  );
}

function Page() {
  const { file, pageTree } = useFumadocsLoader(Route.useLoaderData());
  return (
    <DocsLayout {...baseOptions()} tree={pageTree}>
      <Suspense>
        <Content file={file} />
      </Suspense>
    </DocsLayout>
  );
}
