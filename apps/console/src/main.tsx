import { ApertureUIRoot } from "@aperture-browser/session-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { carry } from "./lib/api.ts";
import { token } from "./lib/token.ts";
import { router } from "./router.tsx";
import "./styles.css";

const queries = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// Whoever signed in before may have lost what the browser carries to sessions since.
const signedIn = token();
if (signedIn !== undefined) {
  void carry(signedIn);
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <ApertureUIRoot>
      <QueryClientProvider client={queries}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApertureUIRoot>,
  );
}
