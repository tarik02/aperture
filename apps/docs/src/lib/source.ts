import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { loader, type MetaData, type VirtualFile } from "fumadocs-core/source";
import { pageSchema } from "fumadocs-core/source/schema";
import { applyMdxPreset } from "fumadocs-mdx/config";
import { defineCollections } from "fumadocs-mdx/macro";
import { remarkRepositoryLinks, remarkTitle, titleOf } from "./markdown.ts";
import { pages } from "./pages.ts";

/**
 * The markdown of the repository, read where it is: GitHub shows the same files, so they carry
 * nothing that is the site's alone.
 */
export const files = defineCollections({
  type: "doc",
  dir: "../..",
  files: ["README.md", "docs/*.md", "packages/*/README.md"],
  async: true,
  schema: ({ source }) =>
    pageSchema.extend({ title: pageSchema.shape.title.default(titleOf(source) ?? "Aperture") }),
  mdxOptions: applyMdxPreset({
    remarkPlugins: (plugins) => [remarkTitle, remarkRepositoryLinks, remarkMdxMermaid, ...plugins],
  }),
});

function meta(path: string, data: MetaData): VirtualFile {
  return { type: "meta", path, data };
}

const names = pages.map((page) => page.slug).filter((slug) => !slug.includes("/"));
const packages = pages.map((page) => page.slug).filter((slug) => slug.startsWith("packages/"));

export const source = loader({
  baseUrl: "/",
  source: {
    files: [
      ...pages.flatMap((page) => {
        const data = files.get(page.file);
        if (!data) throw new Error(`${page.file} is no file of the repository`);
        return { type: "page" as const, path: `${page.slug || "index"}.md`, data };
      }),
      meta("meta.json", {
        title: "Aperture",
        pages: [...names.map((slug) => slug || "index"), "---Packages---", "...packages"],
      }),
      meta("packages/meta.json", {
        title: "Packages",
        pages: packages.map((slug) => slug.slice("packages/".length)),
      }),
    ],
  },
});
