import { Observable, filter, map, merge, scan, share, startWith } from "rxjs";
import type { ApiCredentials } from "#/lib/api/client.ts";
import {
  browserControlConnection$,
  type ControlConnectionEvent,
} from "#/lib/control/connection.ts";
import type {
  ClientMessage,
  ControlConnectionPhase,
  ControlError,
  ControlTarget,
  ScreencastFrame,
} from "#/lib/control/messages.ts";

export type CdpControlState = {
  phase: ControlConnectionPhase;
  targets: ControlTarget[];
  activeTargetId: string | null;
  frame: ScreencastFrame | null;
  lastError: ControlError | null;
};

export type CdpControlOptions = {
  sessionId: string;
  credentials: ApiCredentials;
  input$: Observable<ClientMessage>;
};

export type CdpControlOutput =
  | { type: "state"; state: CdpControlState }
  | { type: "error"; error: ControlError };

const initialState: CdpControlState = {
  phase: "idle",
  targets: [],
  activeTargetId: null,
  frame: null,
  lastError: null,
};

export function cdpControl$(options: CdpControlOptions): Observable<CdpControlOutput> {
  return new Observable<CdpControlOutput>((subscriber) => {
    const events$ = browserControlConnection$(options).pipe(share());
    const subscription = merge(
      events$.pipe(scan(reduce, initialState), startWith(initialState), map(stateOutput)),
      events$.pipe(
        filter((event) => event.type === "error"),
        map(errorOutput),
      ),
    ).subscribe(subscriber);

    return () => subscription.unsubscribe();
  });
}

function reduce(state: CdpControlState, event: ControlConnectionEvent): CdpControlState {
  switch (event.type) {
    case "phase":
      return {
        ...state,
        phase: event.phase,
        lastError: event.phase === "connected" ? null : state.lastError,
        frame: event.phase === "disconnected" || event.phase === "error" ? null : state.frame,
      };
    case "targets-snapshot": {
      const orderedTargets = mergeTargetsInCurrentOrder(state.targets, event.targets);
      const activeTargetId =
        event.activeTargetId ??
        event.targets.find((target) => target.id === state.activeTargetId)?.id ??
        event.targets[0]?.id ??
        null;
      return { ...state, targets: orderedTargets, activeTargetId };
    }
    case "screencast-frame":
      return { ...state, frame: event.frame };
    case "screencast-stopped":
      return { ...state, frame: null };
    case "error":
      return { ...state, lastError: event.error };
    case "target-changed":
      return state;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function stateOutput(state: CdpControlState): CdpControlOutput {
  return { type: "state", state };
}

function errorOutput(event: Extract<ControlConnectionEvent, { type: "error" }>): CdpControlOutput {
  return { type: "error", error: event.error };
}

function mergeTargetsInCurrentOrder(
  currentTargets: ControlTarget[],
  nextTargets: ControlTarget[],
): ControlTarget[] {
  const byId = new Map(nextTargets.map((target) => [target.id, target]));
  const seen = new Set<string>();
  const ordered: ControlTarget[] = [];

  for (const current of currentTargets) {
    const next = byId.get(current.id);
    if (next) {
      ordered.push(next);
      seen.add(next.id);
    }
  }
  for (const target of nextTargets) {
    if (!seen.has(target.id)) {
      ordered.push(target);
    }
  }
  return ordered;
}
