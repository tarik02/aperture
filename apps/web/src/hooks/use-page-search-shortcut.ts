import { useEffect, useRef } from "react";

// Ctrl+F / Cmd+F focuses the page's primary search instead of the browser find bar;
// Escape leaves the field while keeping its text.
export function usePageSearchShortcut(enabled = true) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const input = inputRef.current;
      if (event.defaultPrevented || input === null) {
        return;
      }

      if (event.key === "Escape" && document.activeElement === input) {
        event.preventDefault();
        input.blur();
        return;
      }

      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        (event.code !== "KeyF" && event.key.toLowerCase() !== "f")
      ) {
        return;
      }

      event.preventDefault();
      input.focus();
      input.select();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled]);

  return inputRef;
}
