import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowLeft, ArrowRight, Check, Layers2, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { Button } from "@aperture-browser/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import { InputGroup, InputGroupInput } from "@aperture-browser/ui/components/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { useInputState } from "../hooks/use-actions.ts";
import { useAddress } from "../hooks/use-address.ts";
import { useFinger, useShortWindow } from "../hooks/use-media.ts";
import { useSession, useSessionSnapshot } from "../session.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { WorkbenchSlot } from "../workbench/slot.tsx";
import { BrowserTabStrip } from "./browser-tab-strip.tsx";
import { SessionPresence } from "./session-presence.tsx";

/** The workbench's first row: the tab strip, and who is in the session. */
export function WorkbenchTitlebar() {
  const { features } = useWorkbench();
  const open = useSessionSnapshot().connection.state === "open";
  const oneRow = useOneRow();

  // What is here is in the toolbar where there is one row.
  if (oneRow) {
    return null;
  }
  return (
    <div
      data-workbench-titlebar=""
      className="aperture:flex aperture:h-8 aperture:min-w-0 aperture:shrink-0 aperture:items-stretch aperture:border-b aperture:bg-muted/35 aperture:pointer-coarse:h-10"
    >
      <WorkbenchSlot name="titlebar.start" />
      <BrowserTabStrip />
      {/* Who was here when a connection closed is not who is here now. */}
      {features.presence && open ? <SessionPresence /> : null}
      <WorkbenchSlot name="titlebar.end" />
    </div>
  );
}

export const CompactContext = createContext(false);

/** Whether the toolbar is narrow: what has a place in the browser menu shows there alone. */
export function useCompactToolbar(): boolean {
  return useContext(CompactContext);
}

/**
 * Whether the toolbar is narrow under a finger, whose buttons are larger: then only going
 * back, the keyboard and the files keep a button, and the rest is in the browser menu.
 */
export function useCrowdedToolbar(): boolean {
  return useFinger() && useContext(CompactContext);
}

/** Below this width the toolbar keeps the address bar its room by showing fewer buttons. */
const COMPACT_BELOW = 520;

/**
 * Whether the workbench has the one row of the toolbar, which then has what the title
 * bar has besides the tabs: in a window too short for two, and where there is no strip of
 * tabs, as for one who sees one tab alone.
 */
function useOneRow(): boolean {
  const { features } = useWorkbench();
  return useShortWindow() || !features.tabs;
}

/**
 * The workbench's second row: navigation, the address, and the buttons at its end. Without
 * children it is the usual arrangement of its parts.
 */
export function WorkbenchToolbar({ children }: { readonly children?: ReactNode }) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const compact = useNarrowerThan(toolbarRef, COMPACT_BELOW);
  const { features, contributions } = useWorkbench();
  const open = useSessionSnapshot().connection.state === "open";
  const connecting = useSessionSnapshot().connection.state === "connecting";
  const short = useShortWindow();
  const oneRow = useOneRow();
  const shows =
    children !== undefined ||
    features.navigation ||
    features.addressBar ||
    features.menus ||
    (oneRow && features.presence) ||
    contributions.some((one) =>
      oneRow
        ? one.slot.startsWith("toolbar.") || one.slot.startsWith("titlebar.")
        : one.slot.startsWith("toolbar."),
    );

  if (!shows) {
    return null;
  }
  return (
    <CompactContext.Provider value={compact}>
      <div
        ref={toolbarRef}
        data-workbench-toolbar=""
        data-compact={compact ? "" : undefined}
        data-short={short ? "" : undefined}
        // What stands at the title bar's start stands at the window's edge here too.
        data-flush={
          oneRow && contributions.some((one) => one.slot === "titlebar.start") ? "" : undefined
        }
        className="aperture:flex aperture:h-9 aperture:min-w-0 aperture:shrink-0 aperture:items-center aperture:gap-1 aperture:border-b aperture:bg-background aperture:px-1.5 aperture:pointer-coarse:h-11 aperture:data-flush:pl-0"
      >
        {children ?? (
          <>
            {oneRow ? <WorkbenchSlot name="titlebar.start" /> : null}
            {short && features.tabs ? <TabsMenu /> : null}
            <WorkbenchSlot name="toolbar.start" />
            {features.navigation ? <NavigationButtons /> : null}
            {features.addressBar ? (
              <AddressBar />
            ) : (
              <div className="aperture:min-w-0 aperture:flex-1" />
            )}
            {connecting ? (
              <Loader2 className="aperture:size-4 aperture:shrink-0 aperture:animate-spin aperture:text-muted-foreground" />
            ) : null}
            <WorkbenchSlot name="toolbar.end" />
            {oneRow && features.presence && open ? <SessionPresence /> : null}
            {oneRow ? <WorkbenchSlot name="titlebar.end" /> : null}
            {features.menus ? <ToolbarActions /> : null}
          </>
        )}
      </div>
    </CompactContext.Provider>
  );
}

/** Back, forward and reload of the watched tab. */
export function NavigationButtons() {
  const session = useSession();
  const input = useInputState();
  const snapshot = useSessionSnapshot();
  // Where a tab goes is no input to its page: it takes no lease.
  const gives = input.changes && snapshot.selected !== undefined;
  const watched = snapshot.targets.find((target) => target.tab === snapshot.selected);
  const crowded = useCrowdedToolbar();

  return (
    <div className="aperture:flex aperture:shrink-0 aperture:items-center aperture:gap-0.5">
      <ToolbarButton
        label="Back"
        disabled={!gives || watched?.goesBack !== true}
        onClick={() => session.go({ along: "back" })}
      >
        <ArrowLeft />
      </ToolbarButton>
      {crowded ? null : (
        <>
          <ToolbarButton
            label="Forward"
            disabled={!gives || watched?.goesForward !== true}
            onClick={() => session.go({ along: "forward" })}
          >
            <ArrowRight />
          </ToolbarButton>
          <ToolbarButton
            label="Reload"
            disabled={!gives}
            onClick={() => session.go({ along: "reload" })}
          >
            <RefreshCw />
          </ToolbarButton>
        </>
      )}
    </div>
  );
}

/** The watched tab's address, and the field to take it elsewhere. */
export function AddressBar() {
  const session = useSession();
  const address = useAddress();

  return (
    <InputGroup className="aperture:h-7 aperture:min-w-0 aperture:pointer-coarse:h-10 aperture:border-transparent aperture:bg-transparent aperture:transition-colors aperture:hover:border-input/50 aperture:hover:bg-muted/35 aperture:has-[[data-slot=input-group-control]:focus-visible]:border-input/70 aperture:has-[[data-slot=input-group-control]:focus-visible]:bg-background aperture:has-[[data-slot=input-group-control]:focus-visible]:ring-2 aperture:has-[[data-slot=input-group-control]:focus-visible]:ring-ring/20 aperture:dark:hover:bg-input/20">
      <InputGroupInput
        data-workbench-address=""
        aria-label="Address"
        value={address.value}
        onChange={(event) => address.type(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={address.reset}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (address.submit(event.currentTarget.value)) {
              // The page is what the keyboard is for once it is on its way.
              session.focus();
            }
          }
          if (event.key === "Escape") {
            address.reset();
            event.currentTarget.blur();
          }
        }}
        placeholder="URL"
        inputMode="url"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        // A phone zooms into a field whose text is smaller than this.
        className="aperture:h-7 aperture:px-2 aperture:font-mono aperture:text-xs aperture:text-muted-foreground aperture:transition-colors aperture:focus-visible:text-foreground aperture:pointer-coarse:h-10 aperture:pointer-coarse:text-base"
        disabled={!address.navigates}
      />
    </InputGroup>
  );
}

/**
 * The tabs as a menu, for a window too short to keep a row of them: which is watched, the
 * way to another, to close one and to open a new one.
 */
function TabsMenu() {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const { changes } = useInputState();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Tabs"
            data-workbench-tabs-menu=""
            className="aperture:shrink-0 aperture:tabular-nums"
          />
        }
      >
        <Layers2 />
        {snapshot.targets.length}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="aperture:w-72">
        {snapshot.targets.map((target) => (
          <div key={target.tab} className="aperture:flex aperture:items-center">
            <DropdownMenuItem
              className="aperture:min-w-0 aperture:flex-1"
              onClick={() => session.select(target.tab)}
            >
              <Check
                className={target.tab === snapshot.selected ? undefined : "aperture:invisible"}
              />
              <span className="aperture:truncate">{target.title || target.url || "New tab"}</span>
            </DropdownMenuItem>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Close ${target.title || "tab"}`}
              disabled={!changes}
              onClick={() => session.closeTab(target.tab)}
            >
              <X />
            </Button>
          </div>
        ))}
        {snapshot.targets.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem disabled={!changes} onClick={() => session.newTab()}>
          <Plus />
          New tab
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The buttons at the toolbar's end, which are what is contributed to `toolbar.actions`. */
export function ToolbarActions() {
  return (
    <div
      data-workbench-menus=""
      className="aperture:flex aperture:shrink-0 aperture:items-center aperture:gap-0.5"
    >
      <WorkbenchSlot name="toolbar.actions" />
    </div>
  );
}

function useNarrowerThan(ref: RefObject<HTMLElement | null>, width: number): boolean {
  const [narrower, setNarrower] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }
    const measure = () => setNarrower(element.clientWidth < width);
    measure();
    const sizes = new ResizeObserver(measure);
    sizes.observe(element);
    return () => sizes.disconnect();
  }, [ref, width]);

  return narrower;
}

/** A button of the toolbar, with its name as a tooltip. */
export function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
  ...props
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
} & Omit<ComponentProps<typeof Button>, "children" | "onClick" | "disabled">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
