import { createContext } from "react";

// The header slot mounts in the same commit as the page, so pages must learn about it through
// state instead of querying the DOM during their first render.
export const PageHeaderActionsTarget = createContext<HTMLElement | null>(null);
