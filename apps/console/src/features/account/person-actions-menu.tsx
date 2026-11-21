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
  ShieldOff,
  Trash2,
  UserCheck,
  UserX,
} from "lucide-react";
import { Fragment } from "react";
import type { Account } from "#/features/account/account.queries.ts";

/** What is done with a person. */
export type PersonDoing = "setup-link" | "reset" | "passkeys" | "disable" | "enable" | "delete";

/** One thing done with a person, as a menu of either kind offers it. */
interface PersonAction {
  readonly key: PersonDoing;
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
export const personActions = (account: Account, own: boolean): ReadonlyArray<PersonAction> => [
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

const MENU = "aperture:w-auto aperture:min-w-44 aperture:whitespace-nowrap";

type Menu = {
  actions: ReadonlyArray<PersonAction>;
  onSelect: (doing: PersonDoing) => void;
};

/** A person's actions behind a button. */
export function PersonActionsMenu({ actions, onSelect }: Menu) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Person actions"
            data-console-person-actions
          />
        }
      >
        <EllipsisVertical />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={MENU}>
        {actions.map((action, index) => (
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

/** The same actions where a right click was, on whatever it wraps. */
export function PersonContextMenu({
  actions,
  onSelect,
  children,
}: Menu & { children: React.ReactElement }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent data-console-person-context className={MENU}>
        {actions.map((action) => (
          <Fragment key={action.key}>
            {action.parted === true ? <ContextMenuSeparator /> : null}
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
