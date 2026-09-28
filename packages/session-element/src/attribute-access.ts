import { shareSessionAccess, type SessionAccess } from "@aperture-browser/session-react/headless";

/**
 * Resolves the `token` and `base-url` attributes to session access. A new access object
 * reconnects the session, so the previous one is reused while both attributes are unchanged.
 */
export function attributeAccess(): (element: HTMLElement) => SessionAccess | null {
  let last: { token: string | null; baseUrl: string | null; access: SessionAccess | null } | null =
    null;
  return (element) => {
    const token = element.getAttribute("token");
    const baseUrl = element.getAttribute("base-url");
    if (last === null || last.token !== token || last.baseUrl !== baseUrl) {
      const access = token === null ? null : shareSessionAccess(token, baseUrl ?? undefined);
      last = { token, baseUrl, access };
    }
    return last.access;
  };
}
