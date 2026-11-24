import type { Nodes, Root } from "mdast";
import { pageOf, pages, repositoryUrl } from "./pages.ts";

const TITLE = /^# (.+)$/m;

/** What a page is called: its first heading, as GitHub shows it at the top of the file. */
export function titleOf(source: string): string | undefined {
  return TITLE.exec(source)?.[1]?.trim();
}

/** Which file of the repository a file on the disk is, of the files that are pages. */
function fileOf(path: string): string | undefined {
  return pages
    .map((page) => page.file)
    .filter((file) => path === file || path.endsWith(`/${file}`))
    .toSorted((one, other) => other.length - one.length)[0];
}

/**
 * Where a link written for GitHub leads from the site: to the page the file it names is here,
 * and to GitHub for the rest of the repository.
 */
export function resolveLink(from: string, url: string): string {
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return url;
  const target = new URL(url, `file:///${from}`);
  const file = decodeURIComponent(target.pathname).replace(/^\/+|\/+$/g, "");
  const page = pageOf(file);
  if (page) return `/${page.slug}${target.hash}`;
  // GitHub sends a directory asked for as a file on to where it lists it.
  return `${repositoryUrl}/blob/master/${file}${target.hash}`;
}

function visit(node: Nodes, each: (node: Nodes) => void) {
  each(node);
  if ("children" in node) for (const child of node.children) visit(child, each);
}

/** Takes the first heading out of the page, which shows it as its title. */
export function remarkTitle() {
  return (tree: Root) => {
    const at = tree.children.findIndex((node) => node.type === "heading" && node.depth === 1);
    if (at !== -1) tree.children.splice(at, 1);
  };
}

/** Has the links between the files of the repository lead where the site has them. */
export function remarkRepositoryLinks() {
  return (tree: Root, file: { path: string }) => {
    const from = fileOf(file.path.replaceAll("\\", "/"));
    if (from === undefined) return;
    visit(tree, (node) => {
      if (node.type === "link" || node.type === "definition") {
        node.url = resolveLink(from, node.url);
      }
    });
  };
}
