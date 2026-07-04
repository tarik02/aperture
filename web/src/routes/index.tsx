import { createFileRoute } from "@tanstack/react-router";
import { AppWindow } from "lucide-react";
import { z } from "zod";
import { useAppStore } from "../stores/app";

const appInfoSchema = z.object({
  name: z.literal("Aperture"),
});

const appInfo = appInfoSchema.parse({ name: "Aperture" });

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const ready = useAppStore((state) => state.ready);

  return (
    <main>
      <AppWindow aria-hidden size={16} strokeWidth={1.75} />
      <h1>{appInfo.name}</h1>
      <p>{ready ? "UI stack ready" : "Starting"}</p>
    </main>
  );
}
