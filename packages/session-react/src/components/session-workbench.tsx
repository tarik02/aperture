import { useMemo, type ReactNode } from "react";
import { resolveContributions, type WorkbenchContributions } from "../workbench/contributions.ts";
import {
  useWorkbench,
  WorkbenchProvider,
  type WorkbenchProviderProps,
} from "../workbench/context.tsx";
import { workbenchContributions } from "../workbench/own.ts";
import { WorkbenchTitlebar, WorkbenchToolbar } from "./browser-toolbar.tsx";
import { BrowserViewport } from "./browser-viewport.tsx";
import { KeptGallery } from "./kept-gallery.tsx";
import { PageMenu } from "./page-menu.tsx";

export interface SessionWorkbenchProps extends Omit<
  WorkbenchProviderProps,
  "contributions" | "children"
> {
  /**
   * More for the workbench's slots, each in place of the workbench's own of the same id;
   * or a function of the workbench's own that gives all there are to be.
   */
  readonly contributions?: WorkbenchContributions | undefined;
  /**
   * Another arrangement of the workbench's parts, in place of the usual one: the title
   * bar, the toolbar, the picture and the page's menu.
   */
  readonly children?: ReactNode;
}

/**
 * One session as a browser to work in: the tab strip with the session's members, the
 * toolbar with its menus, the picture, and the menu of a right click in it.
 */
export function SessionWorkbench({ contributions, children, ...provider }: SessionWorkbenchProps) {
  const resolved = useMemo(
    () => resolveContributions(workbenchContributions, contributions),
    [contributions],
  );

  return (
    <WorkbenchProvider {...provider} contributions={resolved}>
      <WorkbenchFrame>{children ?? <WorkbenchParts />}</WorkbenchFrame>
    </WorkbenchProvider>
  );
}

/** The box the workbench's parts stand in, one below the other. */
export function WorkbenchFrame({ children }: { readonly children?: ReactNode }) {
  return (
    <div
      data-session-workbench=""
      className="aperture:flex aperture:h-full aperture:min-h-0 aperture:min-w-0 aperture:flex-1 aperture:flex-col aperture:overflow-hidden aperture:bg-background"
    >
      {children}
    </div>
  );
}

function WorkbenchParts() {
  const { features } = useWorkbench();
  return (
    <>
      <WorkbenchTitlebar />
      <WorkbenchToolbar />
      <BrowserViewport />
      {features.pageMenu ? <PageMenu /> : null}
      {features.recordings ? <KeptGallery /> : null}
    </>
  );
}
