import { useEffect, useState } from "react";

/**
 * Whether the element is on screen, or close to it. A hidden element (`display: none`) never is.
 * Pass the element from a callback ref so the observer follows it.
 */
export function useInView(element: Element | null, rootMargin = "200px") {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (!element) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry?.isIntersecting ?? false),
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, rootMargin]);

  return inView;
}
