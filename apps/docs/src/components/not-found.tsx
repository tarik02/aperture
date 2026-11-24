import { Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "#/lib/layout.tsx";

export function NotFound() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-4 px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Page not found</h1>
        <p className="text-fd-muted-foreground">Nothing is at this address.</p>
        <div>
          <Link
            to="/$"
            params={{ _splat: "" }}
            className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
          >
            To the documentation
          </Link>
        </div>
      </main>
    </HomeLayout>
  );
}
