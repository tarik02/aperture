import { useState } from "react";

/**
 * What a value last was while there was one: a dialog that shows it keeps showing it while
 * it closes, after the value is gone.
 */
export function useLast<A>(value: A | undefined) {
  const [last, setLast] = useState(value);
  if (value !== undefined && value !== last) {
    setLast(value);
  }
  return value ?? last;
}
