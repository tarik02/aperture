import { createContext, useContext, useEffect } from "react";

/**
 * Tells the title bar what a page within a page shows: whose it is, after the page's name,
 * and what of theirs it is, after that.
 */
export const PageCrumb = createContext<(crumb: ReadonlyArray<string> | undefined) => void>(
  () => undefined,
);

export function usePageCrumb(crumb: string | ReadonlyArray<string> | undefined) {
  const tell = useContext(PageCrumb);
  // Told again only when it says something else, not for each array that says the same.
  const said = crumb === undefined ? undefined : JSON.stringify([crumb].flat());
  useEffect(() => {
    tell(said === undefined ? undefined : (JSON.parse(said) as ReadonlyArray<string>));
    return () => tell(undefined);
  }, [tell, said]);
}
