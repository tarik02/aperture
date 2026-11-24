import { createContext, useContext, useEffect } from "react";

/** Tells the title bar what a page within a page shows: whose it is, after the page's name. */
export const PageCrumb = createContext<(crumb: string | undefined) => void>(() => undefined);

export function usePageCrumb(crumb: string | undefined) {
  const tell = useContext(PageCrumb);
  useEffect(() => {
    tell(crumb);
    return () => tell(undefined);
  }, [tell, crumb]);
}
