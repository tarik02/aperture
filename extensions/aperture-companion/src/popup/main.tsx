import "../popup.css";

import { createRoot } from "react-dom/client";
import { AddConnectionScreen } from "./add-connection-screen.tsx";
import { HomeScreen } from "./home-screen.tsx";
import { TabsScreen } from "./tabs-screen.tsx";
import { usePopup } from "./use-popup.ts";

function CompanionPopup() {
  const popup = usePopup();

  if (!popup.initialized) {
    return <main className="h-[34rem] w-96 p-3 text-sm text-muted-foreground">Loading…</main>;
  }

  return (
    <main className="flex h-[34rem] w-96 flex-col gap-4 overflow-hidden p-3">
      {popup.screen === "home" && popup.connection !== null ? (
        <HomeScreen popup={popup} connection={popup.connection} />
      ) : null}
      {popup.screen === "add-connection" ? <AddConnectionScreen popup={popup} /> : null}
      {popup.screen === "tabs" ? <TabsScreen popup={popup} /> : null}
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing companion root element");
}
createRoot(root).render(<CompanionPopup />);
