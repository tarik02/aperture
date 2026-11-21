import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { carry } from "#/lib/api.ts";
import { token } from "#/lib/token.ts";
import { AppProviders } from "#/providers/app-providers.tsx";
import { router } from "#/router.tsx";
import "#/styles.css";

// Whoever signed in before may have lost what the browser carries to sessions since.
const signedIn = token();
if (signedIn !== undefined) {
  void carry(signedIn);
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  );
}
