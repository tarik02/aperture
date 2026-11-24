import { Button } from "@aperture-browser/ui/components/button";
import { useEffect } from "react";
import { toast } from "sonner";
import { ApertureMark } from "#/components/aperture-mark.tsx";
import { WindowTitlebar } from "#/components/window-titlebar.tsx";
import { askNow, useAnswering, useSaysNotAnswering } from "#/lib/answering.ts";
import { useDocumentTitle } from "#/lib/document-title.ts";

const TITLE = "Aperture is not answering";
const NOTE = "It is asked again by itself.";

/** Asks now what was not answered, without the rest of the pause before it is asked again. */
export function TryNow() {
  const { asking } = useAnswering();
  return (
    <Button data-console-try-now pending={asking} onClick={askNow}>
      Try now
    </Button>
  );
}

/** What says that Aperture is not answering, for a page that has a frame of its own for it. */
export function NotAnsweringNote() {
  useSaysNotAnswering();
  return (
    <span role="alert" data-console-not-answering>
      {TITLE}. {NOTE}
    </span>
  );
}

/**
 * What is shown in a page's place while Aperture does not answer what the page cannot do
 * without: who is signed in, how people sign in, what the page is of. The page is there
 * again by itself once it is answered.
 */
export function NotAnswering() {
  useDocumentTitle(TITLE);
  useSaysNotAnswering();
  return (
    <main
      data-console-not-answering
      className="aperture:flex aperture:h-full aperture:items-center aperture:justify-center aperture:bg-muted/40 aperture:p-4"
    >
      <WindowTitlebar over />
      <section className="aperture:flex aperture:w-full aperture:max-w-80 aperture:flex-col aperture:items-center aperture:gap-4 aperture:rounded-xl aperture:border aperture:bg-card aperture:p-6 aperture:text-center aperture:shadow-sm">
        <span className="aperture:grid aperture:size-10 aperture:place-items-center aperture:rounded-xl aperture:bg-primary aperture:text-primary-foreground">
          <ApertureMark className="aperture:size-5.5" />
        </span>
        <h1 className="aperture:text-base aperture:font-semibold">{TITLE}</h1>
        <p role="alert" className="aperture:text-sm aperture:text-muted-foreground">
          {NOTE}
        </p>
        <TryNow />
      </section>
    </main>
  );
}

const NOTICE = "not-answering";

/**
 * Says that Aperture is not answering over a page that still shows what it was answered
 * before, and so has no place of its own to say it in.
 */
export function NotAnsweringNotice() {
  const { down, said } = useAnswering();
  const shown = down && !said;
  useEffect(() => {
    if (!shown) {
      toast.dismiss(NOTICE);
      return;
    }
    toast.warning(TITLE, {
      id: NOTICE,
      description: NOTE,
      duration: Infinity,
      closeButton: false,
      action: {
        label: "Try now",
        onClick: (event) => {
          // It stays until Aperture answers.
          event.preventDefault();
          askNow();
        },
      },
    });
  }, [shown]);
  return null;
}
