import { useMemo } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ClipboardPaste,
  Copy,
  ExternalLink,
  Image,
  Link2,
  RefreshCw,
  TextSelect,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@aperture-browser/ui/components/dropdown-menu";
import { copyTextHere, pasteHere } from "../notices.ts";
import { useSession, useSessionSnapshot } from "../session.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { WorkbenchMenuSlot } from "../workbench/slot.tsx";

/**
 * The menu of a right click in the session. The session's browser shows none: the session
 * tells what the click was on when the page made nothing of it, and the menu is shown
 * here, where the click was.
 */
export function PageMenu() {
  const session = useSession();
  const { menu } = useSessionSnapshot();
  const x = menu?.x ?? 0;
  const y = menu?.y ?? 0;

  // The place of the click, as an element the menu is laid out against.
  const anchor = useMemo(() => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }), [x, y]);

  if (menu === undefined) {
    return null;
  }
  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          session.dismissMenu();
        }
      }}
    >
      <DropdownMenuContent
        data-session-page-menu=""
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={0}
        collisionPadding={4}
        className="aperture:w-auto aperture:min-w-52"
      >
        <WorkbenchMenuSlot name="menu.page" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The keyboard is the session's again once the menu has closed and given focus back.
function useAct() {
  const session = useSession();
  return (action: () => void) => () => {
    action();
    requestAnimationFrame(() => session.focus());
  };
}

/** For a click on a link. */
export function PageLinkItems() {
  const session = useSession();
  const link = useSessionSnapshot().menu?.link;
  const act = useAct();

  if (link === undefined) {
    return null;
  }
  return (
    <>
      <DropdownMenuItem onClick={act(() => session.go({ url: link }, { newTab: true }))}>
        <ExternalLink />
        Open link in new tab
      </DropdownMenuItem>
      <DropdownMenuItem onClick={act(() => copyTextHere(session, link, "Link copied"))}>
        <Link2 />
        Copy link address
      </DropdownMenuItem>
    </>
  );
}

/** For a click on a picture. */
export function PagePictureItems() {
  const session = useSession();
  const image = useSessionSnapshot().menu?.image;
  const { features } = useWorkbench();
  const act = useAct();

  if (image === undefined) {
    return null;
  }
  return (
    <>
      <DropdownMenuItem onClick={act(() => session.go({ url: image }, { newTab: true }))}>
        <ExternalLink />
        Open picture in new tab
      </DropdownMenuItem>
      {features.clipboard ? (
        <DropdownMenuItem onClick={act(() => session.copyPicture(image))}>
          <Image />
          Copy picture
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onClick={act(() => copyTextHere(session, image, "Picture address copied"))}>
        <Link2 />
        Copy picture address
      </DropdownMenuItem>
    </>
  );
}

/** For a click on selected text, or in a field to write into. */
export function PageTextItems() {
  const session = useSession();
  const menu = useSessionSnapshot().menu;
  const { features } = useWorkbench();
  const act = useAct();

  return (
    <>
      {menu?.text === undefined || !features.clipboard ? null : (
        <DropdownMenuItem onClick={act(session.copySelection)}>
          <Copy />
          Copy
        </DropdownMenuItem>
      )}
      {menu?.editable ? (
        <>
          {features.clipboard ? (
            <DropdownMenuItem onClick={act(() => pasteHere(session))}>
              <ClipboardPaste />
              Paste
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={act(session.selectAll)}>
            <TextSelect />
            Select all
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

export function PageNavigationItems() {
  const session = useSession();
  const act = useAct();

  return (
    <>
      <DropdownMenuItem onClick={act(() => session.go({ along: "back" }))}>
        <ArrowLeft />
        Back
      </DropdownMenuItem>
      <DropdownMenuItem onClick={act(() => session.go({ along: "forward" }))}>
        <ArrowRight />
        Forward
      </DropdownMenuItem>
      <DropdownMenuItem onClick={act(() => session.go({ along: "reload" }))}>
        <RefreshCw />
        Reload
      </DropdownMenuItem>
    </>
  );
}
