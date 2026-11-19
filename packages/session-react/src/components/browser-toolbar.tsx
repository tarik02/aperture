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
import { ArrowLeft, ArrowRight, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@aperture-browser/ui/components/button";
import { InputGroup, InputGroupInput } from "@aperture-browser/ui/components/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@aperture-browser/ui/components/tooltip";
import { useInputState } from "../hooks/use-actions.ts";
import { useAddress } from "../hooks/use-address.ts";
import { useSession, useSessionSnapshot } from "../session.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { WorkbenchSlot } from "../workbench/slot.tsx";
import { BrowserTabStrip } from "./browser-tab-strip.tsx";
import { SessionPresence } from "./session-presence.tsx";

/** The workbench's first row: the tab strip, and who is in the session. */
export function WorkbenchTitlebar() {
  const { features, contributions } = useWorkbench();
  const open = useSessionSnapshot().connection.state === "open";
  const contributed = contributions.some((one) => one.slot.startsWith("titlebar."));

  if (!features.tabs && !features.presence && !contributed) {
    return null;
  }
  return (
    <div
      data-workbench-titlebar=""
      className="aperture:flex aperture:h-8 aperture:min-w-0 aperture:shrink-0 aperture:items-stretch aperture:border-b aperture:bg-muted/35"
    >
      <WorkbenchSlot name="titlebar.start" />
      {features.tabs ? <BrowserTabStrip /> : <div className="aperture:min-w-0 aperture:flex-1" />}
      {/* Who was here when a connection closed is not who is here now. */}
      {features.presence && open ? <SessionPresence /> : null}
      <WorkbenchSlot name="titlebar.end" />
    </div>
  );
}

const CompactContext = createContext(false);

/** Whether the toolbar is narrow: what has a place in the browser menu shows there alone. */
export function useCompactToolbar(): boolean {
  return useContext(CompactContext);
}

/** Below this width the toolbar keeps the address bar its room by showing fewer buttons. */
const COMPACT_BELOW = 520;

/**
 * The workbench's second row: navigation, the address, and the buttons at its end. Without
 * children it is the usual arrangement of its parts.
 */
export function WorkbenchToolbar({ children }: { readonly children?: ReactNode }) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const compact = useNarrowerThan(toolbarRef, COMPACT_BELOW);
  const { features, contributions } = useWorkbench();
  const connecting = useSessionSnapshot().connection.state === "connecting";
  const shows =
    children !== undefined ||
    features.navigation ||
    features.addressBar ||
    features.menus ||
    contributions.some((one) => one.slot === "toolbar.start" || one.slot === "toolbar.end");

  if (!shows) {
    return null;
  }
  return (
    <CompactContext.Provider value={compact}>
      <div
        ref={toolbarRef}
        data-workbench-toolbar=""
        data-compact={compact ? "" : undefined}
        className="aperture:flex aperture:h-9 aperture:min-w-0 aperture:shrink-0 aperture:items-center aperture:gap-1 aperture:border-b aperture:bg-background aperture:px-1.5"
      >
        {children ?? (
          <>
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
  const { gives } = useInputState();

  return (
    <div className="aperture:flex aperture:shrink-0 aperture:items-center aperture:gap-0.5">
      <ToolbarButton label="Back" disabled={!gives} onClick={() => session.go({ along: "back" })}>
        <ArrowLeft />
      </ToolbarButton>
      <ToolbarButton
        label="Forward"
        disabled={!gives}
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
    </div>
  );
}

/** The watched tab's address, and the field to take it elsewhere. */
export function AddressBar() {
  const session = useSession();
  const address = useAddress();

  return (
    <InputGroup className="aperture:h-7 aperture:min-w-0 aperture:border-transparent aperture:bg-transparent aperture:transition-colors aperture:hover:border-input/50 aperture:hover:bg-muted/35 aperture:has-[[data-slot=input-group-control]:focus-visible]:border-input/70 aperture:has-[[data-slot=input-group-control]:focus-visible]:bg-background aperture:has-[[data-slot=input-group-control]:focus-visible]:ring-2 aperture:has-[[data-slot=input-group-control]:focus-visible]:ring-ring/20 aperture:dark:hover:bg-input/20">
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
        className="aperture:h-7 aperture:px-2 aperture:font-mono aperture:text-xs aperture:text-muted-foreground aperture:transition-colors aperture:focus-visible:text-foreground"
        disabled={!address.navigates}
      />
    </InputGroup>
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
