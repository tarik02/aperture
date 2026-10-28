import * as Redacted from "effect/Redacted";
import type { BrowserPage, Session, SessionStatus } from "@aperture-browser/api-client";

/** Statuses whose browser can be opened; connecting wakes a suspended one. */
export function isOpenable(status: SessionStatus): boolean {
  return status === "running" || status === "suspended";
}

/** Statuses a snapshot can be saved from. */
export function isSaveable(status: SessionStatus): boolean {
  return status === "running" || status === "suspended";
}

export function isReopenable(status: SessionStatus): boolean {
  return status === "deleted" || status === "failed";
}

/**
 * Aperture keeps listing an expired session under its last status while every request for it
 * returns 410, so the list hides it by its deadline as well.
 */
export function isExpired(session: Session, now = Date.now()): boolean {
  return session.status === "expired" || Date.parse(session.expiresAt) <= now;
}

export function sessionLabel(session: Session): string {
  return session.label ?? session.baseSnapshotName ?? session.id.slice(0, 8);
}

/** An unlabelled session is better named by its open page than by an id. */
export function sessionTitle(session: Session, pages: readonly BrowserPage[] | undefined): string {
  return session.label ?? openPages(pages)[0]?.title ?? sessionLabel(session);
}

export function openPages(pages: readonly BrowserPage[] | undefined): readonly BrowserPage[] {
  return pages?.filter((page) => page.state !== "closed") ?? [];
}

/** Running first, then suspended, newest first within each. */
export function compareSaveable(left: Session, right: Session): number {
  if (left.status !== right.status) {
    return left.status === "running" ? -1 : 1;
  }
  return right.createdAt.localeCompare(left.createdAt);
}

/** Adds a version parameter so an image refreshes when the data it came with does. */
export function versionedUrl(url: string, version: number): string {
  try {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.set("v", String(version));
    return parsed.toString();
  } catch {
    return url;
  }
}

export function targetThumbnailUrl(session: Session, targetId: string): string | null {
  const template = session.thumbnail?.targetUrlTemplate;
  return template
    ? Redacted.value(template).replace("{targetId}", encodeURIComponent(targetId))
    : null;
}

/** The tab's captured icon, or null when it has none. The version makes the URL cacheable for good. */
export function targetFaviconUrl(session: Session, page: BrowserPage): string | null {
  const template = session.favicon?.targetUrlTemplate;
  if (!template || page.faviconAvailable !== true) {
    return null;
  }
  const url = Redacted.value(template).replace("{targetId}", encodeURIComponent(page.targetId));
  return page.faviconVersion ? `${url}&v=${encodeURIComponent(page.faviconVersion)}` : url;
}

export function matchesSearch(needle: string, values: ReadonlyArray<string | null | undefined>) {
  return values.some((value) => value?.toLowerCase().includes(needle) === true);
}

export function sessionThumbnailUrl(session: Session): string | null {
  return session.thumbnail ? Redacted.value(session.thumbnail.url) : null;
}
