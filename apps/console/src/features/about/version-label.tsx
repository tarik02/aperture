import { useAboutQuery } from "#/features/about/about.queries.ts";

const RELEASES = "https://github.com/tarik02/aperture/releases/tag";

/** The version of Aperture the control plane runs, as a link to its release. */
export function VersionLabel() {
  const about = useAboutQuery();
  if (about.data === undefined) {
    return null;
  }
  const version = `v${about.data.version}`;
  return (
    <a
      data-console-version=""
      href={`${RELEASES}/${version}`}
      target="_blank"
      rel="noreferrer"
      title={version}
      className="aperture:truncate aperture:px-2 aperture:text-xs aperture:text-sidebar-foreground/50 aperture:tabular-nums aperture:transition-colors aperture:hover:text-sidebar-foreground aperture:group-data-[collapsible=icon]:hidden"
    >
      {version}
    </a>
  );
}
