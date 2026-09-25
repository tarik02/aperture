import { useEffect, useState, type ReactNode } from "react";
import { RuntimeProvider } from "./effect.tsx";
import { makeApertureRuntime, type ApertureRuntime } from "./runtime.ts";

export interface ApertureProviderProps {
  readonly baseUrl?: string;
  readonly children?: ReactNode;
}

export function ApertureProvider({ baseUrl, children }: ApertureProviderProps) {
  const [runtime, setRuntime] = useState<ApertureRuntime | null>(null);

  useEffect(() => {
    const created = makeApertureRuntime({ baseUrl });
    setRuntime(created);
    return () => {
      setRuntime(null);
      void created.dispose();
    };
  }, [baseUrl]);

  return runtime ? (
    <RuntimeProvider runtime={runtime} baseUrl={baseUrl}>
      {children}
    </RuntimeProvider>
  ) : null;
}
