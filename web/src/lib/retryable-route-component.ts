import { createElement } from "react";
import type { ComponentType } from "react";

type RouteComponent = ComponentType<Record<string, unknown>>;
type RetryableRouteComponent = RouteComponent & {
  preload: () => Promise<void>;
};

const resetters = new Set<() => void>();

export function retryableLazyRouteComponent(
  importer: () => Promise<Record<string, RouteComponent>>,
  exportName = "default",
): RetryableRouteComponent {
  let loadPromise: Promise<void> | undefined;
  let component: RouteComponent | undefined;
  let error: unknown;

  const load = () => {
    if (!loadPromise) {
      loadPromise = importer()
        .then((module) => {
          const loadedComponent = module[exportName];
          if (!loadedComponent) {
            throw new Error(`Route component export ${exportName} is missing`);
          }
          component = loadedComponent;
        })
        .catch((loadError: unknown) => {
          error = loadError;
        });
    }
    return loadPromise;
  };

  const reset = () => {
    error = undefined;
    loadPromise = undefined;
  };
  resetters.add(reset);

  const RouteComponent = (props: Record<string, unknown>) => {
    if (error) {
      throw error;
    }
    if (!component) {
      throw load();
    }
    return createElement(component, props);
  };

  RouteComponent.preload = load;
  return RouteComponent;
}

export function resetRouteComponentFailures() {
  for (const reset of resetters) {
    reset();
  }
}
