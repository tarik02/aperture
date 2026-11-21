import { ApertureMark } from "#/components/aperture-mark.tsx";
import { WindowTitlebar } from "#/components/window-titlebar.tsx";

type AuthCardProps = Omit<React.ComponentProps<"form">, "className"> & {
  title: string;
};

/** The frame of what is asked before anyone is signed in: the mark, what is asked, and the form. */
export function AuthCard({ title, children, ...form }: AuthCardProps) {
  return (
    <main className="aperture:flex aperture:h-full aperture:items-center aperture:justify-center aperture:bg-muted/40 aperture:p-4">
      <WindowTitlebar over />
      <form
        className="aperture:flex aperture:w-full aperture:max-w-80 aperture:flex-col aperture:gap-4 aperture:rounded-xl aperture:border aperture:bg-card aperture:p-6 aperture:shadow-sm"
        {...form}
      >
        <header className="aperture:flex aperture:flex-col aperture:items-center aperture:gap-3">
          <span className="aperture:grid aperture:size-10 aperture:place-items-center aperture:rounded-xl aperture:bg-primary aperture:text-primary-foreground">
            <ApertureMark className="aperture:size-5.5" />
          </span>
          <h1 className="aperture:text-base aperture:font-semibold">{title}</h1>
        </header>
        {children}
      </form>
    </main>
  );
}
