import { useAboutQuery } from "#/features/about/about.queries.ts";

const RELEASES = "https://github.com/tarik02/aperture/releases/tag";

/**
 * The version of Aperture the control plane runs, as a link to its release, with the commit
 * it was built from beside it: between releases every build has the last release's version.
 */
export function VersionLabel() {
  const about = useAboutQuery();
  if (about.data === undefined) {
    return null;
  }
  const { commit } = about.data;
  const version = `v${about.data.version}`;
  const dirty = commit?.endsWith("-dirty") === true;
  const label =
    commit === null ? version : `${version} · ${commit.slice(0, 8)}${dirty ? "-dirty" : ""}`;
  return (
    <a
      data-console-version=""
      href={`${RELEASES}/${version}`}
      target="_blank"
      rel="noreferrer"
      title={commit === null ? version : `${version}, built from ${commit}`}
      className="aperture:truncate aperture:px-2 aperture:text-xs aperture:text-sidebar-foreground/50 aperture:tabular-nums aperture:transition-colors aperture:hover:text-sidebar-foreground aperture:group-data-[collapsible=icon]:hidden"
    >
      {label}
    </a>
  );
}
