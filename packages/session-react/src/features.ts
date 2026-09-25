export interface SessionFeatures {
  readonly tabs?: boolean;
  readonly navigation?: boolean;
  readonly addressBar?: boolean;
  readonly presence?: boolean;
  readonly drawing?: boolean;
  readonly devTools?: boolean;
  readonly menus?: boolean;
  readonly statusBadge?: boolean;
}

export interface ApertureSessionFeatures extends SessionFeatures {
  readonly toaster?: boolean;
}

export type ResolvedSessionFeatures = Required<SessionFeatures>;

export function resolveSessionFeatures(features?: SessionFeatures): ResolvedSessionFeatures {
  return {
    tabs: true,
    navigation: true,
    addressBar: true,
    presence: true,
    drawing: true,
    devTools: true,
    menus: true,
    statusBadge: true,
    ...features,
  };
}
