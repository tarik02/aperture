import { createContext } from "react";

export const AppShellFailureContext = createContext<
  | {
      onShellError: () => void;
      onShellRecovered: () => void;
      onRouteError: () => void;
    }
  | undefined
>(undefined);
