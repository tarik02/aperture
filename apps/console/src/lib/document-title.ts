import { useEffect } from "react";

const NAME = "Aperture";

/** Names the browser's tab after what the page shows: `Aperture | Sessions`. */
export function useDocumentTitle(title: string | undefined, named = true) {
  useEffect(() => {
    // Where something further in names the tab, this leaves it alone.
    if (!named) {
      return undefined;
    }
    document.title = title === undefined || title === "" ? NAME : `${NAME} | ${title}`;
    return () => {
      document.title = NAME;
    };
  }, [title, named]);
}
