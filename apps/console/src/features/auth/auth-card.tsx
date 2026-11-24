import { ApertureMark } from "#/components/aperture-mark.tsx";
import { useDocumentTitle } from "#/lib/document-title.ts";
import { WindowTitlebar } from "#/components/window-titlebar.tsx";

type AuthCardProps = Omit<React.ComponentProps<"form">, "className"> & {
  title: string;
};

/** The frame of what is asked before anyone is signed in: the mark, what is asked, and the form. */
export function AuthCard({ title, children, ...form }: AuthCardProps) {
  useDocumentTitle(title);
  return (
    // Its top stays where it is as it grows by what is said in it: nothing above that moves
    // from under the pointer. It scrolls where the window is short, as over a keyboard.
    <main className="aperture:flex aperture:h-full aperture:items-start aperture:justify-center aperture:overflow-y-auto aperture:bg-muted/40 aperture:p-4 aperture:pt-[max(1rem,env(safe-area-inset-top),calc(50dvh-13rem))]">
      <WindowTitlebar over />
      <form
        className="aperture:flex aperture:w-full aperture:max-w-80 aperture:flex-col aperture:gap-4 aperture:rounded-xl aperture:border aperture:bg-card aperture:p-6 aperture:shadow-sm"
        {...form}
      >
        <header className="aperture:flex aperture:flex-col aperture:items-center aperture:gap-3">
          <span className="aperture:grid aperture:size-10 aperture:place-items-center aperture:rounded-xl aperture:bg-primary aperture:text-primary-foreground">
            <ApertureMark className="aperture:size-5.5" />
          </span>
          <h1 className="aperture:max-w-full aperture:text-center aperture:text-base aperture:font-semibold aperture:wrap-anywhere">
            {title}
          </h1>
        </header>
        {children}
      </form>
    </main>
  );
}
