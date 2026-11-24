export const repositoryUrl = "https://github.com/tarik02/aperture";

/**
 * The files of the repository that are pages here, in the order the sidebar has them, each
 * with where it is on the site. A page is called what its first heading says.
 */
export const pages = [
  { file: "README.md", slug: "" },
  { file: "docs/install.md", slug: "install" },
  { file: "docs/configuration.md", slug: "configuration" },
  { file: "docs/using.md", slug: "using" },
  { file: "docs/upgrading-from-v1.md", slug: "upgrading-from-v1" },
  { file: "packages/control-api/README.md", slug: "packages/control-api" },
  { file: "packages/session-react/README.md", slug: "packages/session-react" },
  { file: "packages/session-element/README.md", slug: "packages/session-element" },
  { file: "packages/session-client/README.md", slug: "packages/session-client" },
  { file: "packages/executor-client/README.md", slug: "packages/executor-client" },
] as const;

/** The page a file of the repository is, of the files that are pages. */
export function pageOf(file: string) {
  // A package is linked to by its directory, which GitHub shows the README of.
  return pages.find((page) => page.file === file || page.file === `${file}/README.md`);
}
