import { Component, lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ComponentType, LazyExoticComponent, ReactNode } from "react";

type RetryableLazyProps<T> = {
  load: () => Promise<{ default: ComponentType<T> }>;
  fallback: ReactNode;
  errorMessage: string;
  onError?: () => void;
  onRetry?: () => void;
  children: (component: LazyExoticComponent<ComponentType<T>>) => ReactNode;
};

type LazyChunkErrorBoundaryProps = {
  children: ReactNode;
  errorMessage: string;
  onError?: () => void;
  onRetry: () => void;
};

type LazyChunkErrorBoundaryState = {
  error: Error | null;
};

export function RetryableLazy<T>({
  load,
  fallback,
  errorMessage,
  onError,
  onRetry,
  children,
}: RetryableLazyProps<T>) {
  const [attempt, setAttempt] = useState(0);
  const LazyComponent = useMemo(() => lazy(load), [attempt, load]);

  return (
    <LazyChunkErrorBoundary
      key={attempt}
      errorMessage={errorMessage}
      onError={onError}
      onRetry={() => {
        setAttempt((current) => current + 1);
        if (typeof window !== "undefined") {
          window.location.reload();
        }
      }}
    >
      <Suspense fallback={fallback}>
        <LazyChunkRecovery attempt={attempt} onRecovered={onRetry}>
          {children(LazyComponent)}
        </LazyChunkRecovery>
      </Suspense>
    </LazyChunkErrorBoundary>
  );
}

function LazyChunkRecovery({
  attempt,
  onRecovered,
  children,
}: {
  attempt: number;
  onRecovered?: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (attempt > 0) {
      onRecovered?.();
    }
  }, [attempt, onRecovered]);

  return children;
}

export function LazyChunkLoadingFallback() {
  return <div className="fixed inset-0 bg-background" aria-busy="true" />;
}

class LazyChunkErrorBoundary extends Component<
  LazyChunkErrorBoundaryProps,
  LazyChunkErrorBoundaryState
> {
  state: LazyChunkErrorBoundaryState = { error: null };

  componentDidCatch() {
    this.props.onError?.();
  }

  static getDerivedStateFromError(error: unknown): LazyChunkErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error("Lazy chunk failed") };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background p-6">
          <div role="alert" className="max-w-sm space-y-4 text-center">
            <p>{this.props.errorMessage}</p>
            <button
              type="button"
              autoFocus
              className="rounded-md border px-3 py-2 text-sm font-medium"
              onClick={this.props.onRetry}
            >
              Retry
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
