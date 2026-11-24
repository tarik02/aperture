import { useState } from "react";
import { useSession, useSessionSnapshot } from "../session.tsx";

export interface AddressControl {
  /** What the address field shows: what is typed, or the watched tab's address. */
  readonly value: string;
  /** Whether this member may take the watched tab elsewhere. */
  readonly navigates: boolean;
  readonly type: (value: string) => void;
  /** Lets go of what was typed and not sent. */
  readonly reset: () => void;
  /** Takes the watched tab to what was typed; false when that is nothing. */
  readonly submit: (value: string) => boolean;
}

/** The watched tab's address, as a field to type another into. */
export function useAddress(): AddressControl {
  const session = useSession();
  const snapshot = useSessionSnapshot();
  const watched = snapshot.targets.find((target) => target.tab === snapshot.selected);
  const [draft, setDraft] = useState<{ tab: number | undefined; url: string } | null>(null);
  // What was typed and not sent belongs to the tab it was typed for.
  const typed = draft !== null && draft.tab === watched?.tab ? draft.url : null;

  return {
    value: typed ?? watched?.url ?? "",
    navigates:
      snapshot.connection.state === "open" && snapshot.features.tabs.write && watched !== undefined,
    type: (url) => setDraft({ tab: watched?.tab, url }),
    reset: () => setDraft(null),
    submit: (value) => {
      const url = value.trim();
      if (url === "") {
        return false;
      }
      session.go({ url: addressOf(url) });
      setDraft(null);
      return true;
    },
  };
}

/** What is typed into an address field as a URL: an address as it is, anything else a search. */
export function addressOf(value: string): string {
  if (isLocalHost(value)) {
    return `http://${value}`;
  }
  if (
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ||
    /^(?:about|chrome|devtools|data|file|view-source):/iu.test(value)
  ) {
    return value;
  }
  if (isLikelyHost(value)) {
    return `https://${value}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function isLocalHost(value: string): boolean {
  return (
    /^localhost(?::\d+)?(?:[/?#].*)?$/iu.test(value) ||
    /^127(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#].*)?$/u.test(value) ||
    /^[a-z0-9-]+:\d+(?:[/?#].*)?$/iu.test(value)
  );
}

function isLikelyHost(value: string): boolean {
  return !/\s/u.test(value) && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#].*)?$/iu.test(value);
}
