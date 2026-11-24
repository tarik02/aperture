import type { Features } from "@aperture-browser/session-client";

/** The parts of the workbench an embedder may leave out. All are shown unless said. */
export interface SessionFeatures {
  /** The tab strip. */
  readonly tabs?: boolean;
  /** Back, forward and reload. */
  readonly navigation?: boolean;
  readonly addressBar?: boolean;
  /** Who is in the session, and the lease of the watched tab. */
  readonly presence?: boolean;
  /** The buttons and menus at the toolbar's end. */
  readonly menus?: boolean;
  /** The session's files: uploads, downloads and what pages ask for. */
  readonly files?: boolean;
  readonly recordings?: boolean;
  /** The menu shown for a right click in the session. */
  readonly pageMenu?: boolean;
  /** Which tabs sound, and muting them. */
  readonly sound?: boolean;
  /** Copying from the session and pasting into it, from the menus. */
  readonly clipboard?: boolean;
}

export interface ApertureSessionFeatures extends SessionFeatures {
  /** Notices as toasts. Without it the embedding page shows none of its own accord. */
  readonly toaster?: boolean;
}

/**
 * What the workbench shows: what the embedder did not leave out, of what this client may
 * read or write at all. `access` tells which of the two, for what depends on it.
 */
export interface ResolvedSessionFeatures extends Required<SessionFeatures> {
  readonly uploads: boolean;
  readonly downloads: boolean;
  readonly access: Features;
}

const any = (grant: { readonly read: boolean; readonly write: boolean }) =>
  grant.read || grant.write;

export function resolveSessionFeatures(
  features: SessionFeatures | undefined,
  access: Features,
): ResolvedSessionFeatures {
  const files = features?.files ?? true;
  const uploads = files && any(access.uploads);
  const downloads = files && access.downloads.read;
  return {
    tabs: true,
    navigation: true,
    addressBar: true,
    presence: true,
    menus: true,
    pageMenu: true,
    ...features,
    recordings: (features?.recordings ?? true) && any(access.recordings),
    clipboard: (features?.clipboard ?? true) && any(access.clipboard),
    sound: (features?.sound ?? true) && access.sound.read,
    uploads,
    downloads,
    files: uploads || downloads,
    access,
  };
}
