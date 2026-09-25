import { createFileRoute, Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "#/lib/layout";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-6 py-16">
        <h1 className="text-4xl font-semibold tracking-tight">Aperture</h1>
        <p className="text-lg text-fd-muted-foreground">
          A self-hosted supervisor for Chromium sessions: start browsers on demand, drive them over
          CDP, share them live, and embed them in your own apps.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            to="/docs/$"
            params={{ _splat: "" }}
            className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
          >
            Read the docs
          </Link>
          <Link
            to="/api-reference"
            className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-fd-accent"
          >
            REST API reference
          </Link>
        </div>
      </main>
    </HomeLayout>
  );
}
