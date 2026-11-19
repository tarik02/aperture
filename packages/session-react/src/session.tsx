import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  connect,
  type ConnectOptions,
  type HeldTab,
  type Member,
  type Role,
  type Session,
  type Snapshot,
  type Target,
} from "@aperture-browser/session-client";

export interface SessionConnection {
  /** None until the page has mounted, and none between two connections. */
  readonly session: Session | null;
  /** Ends the connection there is and makes a new one: a closed connection does not come back. */
  readonly reconnect: () => void;
}

/**
 * Connects to a session for as long as the component is mounted. Another address, name or
 * first way of the picture makes another connection.
 */
export function useConnectedSession({
  url,
  token,
  name,
  pixels,
}: ConnectOptions): SessionConnection {
  const [session, setSession] = useState<Session | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const connected = connect({ url, token, name, pixels });
    setSession(connected);
    return () => {
      setSession(null);
      connected.close();
    };
  }, [url, token, name, pixels, attempt]);

  return useMemo(
    () => ({
      session,
      reconnect: () => setAttempt((current) => current + 1),
    }),
    [session],
  );
}

interface SessionContextValue {
  readonly session: Session;
  readonly reconnect: (() => void) | undefined;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export interface SessionProviderProps {
  readonly session: Session;
  /** Offered where the connection is closed, when there is a way to make another. */
  readonly reconnect?: (() => void) | undefined;
  readonly children?: ReactNode;
}

export function SessionProvider({ session, reconnect, children }: SessionProviderProps) {
  const value = useMemo(() => ({ session, reconnect }), [session, reconnect]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

function useSessionContext(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error("The session's components are used outside a SessionProvider");
  }
  return value;
}

export function useSession(): Session {
  return useSessionContext().session;
}

export function useReconnect(): (() => void) | undefined {
  return useSessionContext().reconnect;
}

export function useSessionSnapshot(): Snapshot {
  const session = useSession();
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

/** The target that is watched. */
export function useWatchedTarget(): Target | undefined {
  const snapshot = useSessionSnapshot();
  return snapshot.targets.find((target) => target.id === snapshot.selected);
}

export type LeaseState =
  /** The role lets this member watch only. */
  | "view-only"
  /** Nobody holds the watched tab: whoever gives it input holds it. */
  | "free"
  | "yours"
  /** This member holds the tab and another asks for it. */
  | "asked-of-you"
  | "theirs"
  /** Another holds the tab and this member has asked for it. */
  | "you-asked"
  /** Another holds the tab and a third member has asked for it. */
  | "theirs-asked";

export interface Lease {
  readonly state: LeaseState;
  /** The member this client is, once the session told. */
  readonly you: Member | undefined;
  readonly role: Role | undefined;
  /** Whether this member's role lets it give input and change the session's tabs. */
  readonly givesInput: boolean;
  readonly held: HeldTab | undefined;
  readonly holder: Member | undefined;
  readonly asker: Member | undefined;
}

/** Who holds the lease of the watched tab, and what this member may do about it. */
export function useLease(): Lease {
  const snapshot = useSessionSnapshot();
  const { presence } = snapshot;
  const watched = snapshot.targets.find((target) => target.id === snapshot.selected);
  const you = presence?.members.find((member) => member.id === presence.you);
  const held = presence?.held.find((one) => one.tab === watched?.tab);
  const holder = presence?.members.find((member) => member.id === held?.holder);
  const asker = presence?.members.find((member) => member.id === held?.askedBy);
  const role = you?.role;
  // A member whose role the session has not told yet is not held back: the session refuses
  // what the role does not allow.
  const givesInput = role !== "view";

  let state: LeaseState = "free";
  if (!givesInput) {
    state = "view-only";
  } else if (held === undefined || presence === undefined) {
    state = "free";
  } else if (held.holder === presence.you) {
    state = held.askedBy === undefined ? "yours" : "asked-of-you";
  } else if (held.askedBy === presence.you) {
    state = "you-asked";
  } else {
    state = held.askedBy === undefined ? "theirs" : "theirs-asked";
  }

  return { state, you, role, givesInput, held, holder, asker };
}
