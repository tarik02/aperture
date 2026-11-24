import "../popup.css";

import { createRoot } from "react-dom/client";
import { AccessScreen } from "./access-screen.tsx";
import { AddConnectionScreen } from "./add-connection-screen.tsx";
import { HomeScreen } from "./home-screen.tsx";
import { TabsScreen } from "./tabs-screen.tsx";
import { usePopup } from "./use-popup.ts";

function CompanionPopup() {
  const popup = usePopup();

  if (!popup.initialized) {
    return (
      <main className="aperture:h-[34rem] aperture:w-96 aperture:p-3 aperture:text-sm aperture:text-muted-foreground">
        Loading…
      </main>
    );
  }

  return (
    <main className="aperture:flex aperture:h-[34rem] aperture:w-96 aperture:flex-col aperture:gap-4 aperture:overflow-hidden aperture:p-3">
      {popup.awaiting !== null ? (
        <AccessScreen popup={popup} awaiting={popup.awaiting} />
      ) : (
        <>
          {popup.screen === "home" && popup.connection !== null ? (
            <HomeScreen popup={popup} connection={popup.connection} />
          ) : null}
          {popup.screen === "add-connection" ? <AddConnectionScreen popup={popup} /> : null}
          {popup.screen === "tabs" ? <TabsScreen popup={popup} /> : null}
        </>
      )}
    </main>
  );
}

// As the console has it: dark where whoever looks asked for dark.
const dark = matchMedia("(prefers-color-scheme: dark)");
const themed = () => document.documentElement.classList.toggle("aperture-dark", dark.matches);
themed();
dark.addEventListener("change", themed);

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing companion root element");
}
createRoot(root).render(<CompanionPopup />);
