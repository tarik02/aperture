import { Button } from "@aperture-browser/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@aperture-browser/ui/components/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@aperture-browser/ui/components/dropdown-menu";
import {
  EllipsisVertical,
  KeyRound,
  Link2,
  type LucideIcon,
  PanelRight,
  ShieldOff,
  SlidersHorizontal,
  Trash2,
  UserCheck,
  UserX,
} from "lucide-react";
import { Fragment } from "react";
import { usePhone } from "#/lib/use-phone.ts";
import type { Account } from "#/features/account/account.queries.ts";

/** What is done with a person. */
export type PersonDoing =
  | "details"
  | "settings"
  | "setup-link"
  | "reset"
  | "passkeys"
  | "disable"
  | "enable"
  | "delete";

/** One thing done with an account, as a menu of either kind offers it. */
interface AccountAction<Doing extends string = string> {
  readonly key: Doing;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  /** A line before it, where another kind of thing begins. */
  readonly parted?: boolean;
}

/**
 * What is done with one person, for their menus. Nobody disables or deletes the account
 * they are signed in with, and nothing is taken from someone who does not have it.
 */
export const personActions = (
  account: Account,
  own: boolean,
): ReadonlyArray<AccountAction<PersonDoing>> => [
  { key: "details", label: "Details", icon: PanelRight },
  { key: "settings", label: "Settings", icon: SlidersHorizontal },
  { key: "setup-link", label: "Setup link", icon: Link2 },
  {
    key: "reset",
    label: "Reset two-factor",
    icon: ShieldOff,
    disabled: account.signIn?.secondFactor !== true,
    parted: true,
  },
  {
    key: "passkeys",
    label: "Remove passkeys",
    icon: KeyRound,
    disabled: (account.signIn?.passkeys ?? 0) === 0,
  },
  account.disabledAt === null
    ? { key: "disable", label: "Disable", icon: UserX, disabled: own, parted: true }
    : { key: "enable", label: "Enable", icon: UserCheck, parted: true },
  { key: "delete", label: "Delete", icon: Trash2, disabled: own, destructive: true },
];

/** What is done with a service account: it has nothing to sign in with, so nothing of that. */
export type ServiceDoing =
  | Extract<PersonDoing, "details" | "disable" | "enable" | "delete">
  | "tokens";

/** What is done with one service account, for its menus. */
export const serviceActions = (
  account: Account,
  own: boolean,
): ReadonlyArray<AccountAction<ServiceDoing>> => [
  { key: "details", label: "Details", icon: PanelRight },
  { key: "tokens", label: "API tokens", icon: KeyRound },
  account.disabledAt === null
    ? { key: "disable", label: "Disable", icon: UserX, disabled: own, parted: true }
    : { key: "enable", label: "Enable", icon: UserCheck, parted: true },
  { key: "delete", label: "Delete", icon: Trash2, disabled: own, destructive: true },
];

const MENU = "aperture:w-auto aperture:min-w-44 aperture:whitespace-nowrap";

type Menu<Doing extends string> = {
  actions: ReadonlyArray<AccountAction<Doing>>;
  onSelect: (doing: Doing) => void;
};

/** An account's actions behind a button: a person's, unless it is said whose. */
export function PersonActionsMenu<Doing extends string>({
  actions,
  onSelect,
  label = "Person actions",
  buttoned,
}: Menu<Doing> & {
  label?: string;
  /** The action that has a button of its own beside the menu, where the row has room for one. */
  buttoned?: Doing;
}) {
  const phone = usePhone();
  // What has a button of its own is not in the menu as well.
  const listed = phone ? actions : actions.filter((action) => action.key !== buttoned);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="icon-sm" variant="ghost" aria-label={label} data-console-person-actions />
        }
      >
        <EllipsisVertical />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={MENU}>
        {listed.map((action, index) => (
          <Fragment key={action.key}>
            {action.parted === true && index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              data-console-person-action={action.key}
              disabled={action.disabled === true}
              variant={action.destructive === true ? "destructive" : "default"}
              onClick={() => onSelect(action.key)}
            >
              <action.icon />
              {action.label}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Whether a press of a row was on the row itself and not on what is pressed within it: a
 * button, a link, a menu. The row opens what it shows then.
 */
export const onRowItself = (event: React.MouseEvent<HTMLElement>) =>
  !(event.target instanceof Element) ||
  event.target.closest("button, a, input, [role=menu], [role=menuitem], [role=dialog]") === null;

/** The same actions where a right click was, on whatever it wraps. */
export function PersonContextMenu<Doing extends string>({
  actions,
  onSelect,
  children,
}: Menu<Doing> & { children: React.ReactElement }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent data-console-person-context className={MENU}>
        {actions.map((action, index) => (
          <Fragment key={action.key}>
            {action.parted === true && index > 0 ? <ContextMenuSeparator /> : null}
            <ContextMenuItem
              disabled={action.disabled === true}
              variant={action.destructive === true ? "destructive" : "default"}
              onClick={() => onSelect(action.key)}
            >
              <action.icon />
              {action.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
