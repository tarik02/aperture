import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

/**
 * What a list is narrowed and ordered by, as its page's address keeps it: each either one
 * of a few values, the first of which is how the list is by itself, or text that is typed.
 */
export type ListSearchShape = Readonly<Record<string, ReadonlyArray<string> | "text">>;

/** What the address says of each, with how the list is by itself where it says nothing. */
export type ListSearch<Shape extends ListSearchShape> = {
  readonly [Key in keyof Shape]: Shape[Key] extends ReadonlyArray<infer Value> ? Value : string;
};

/** What of it the address has to say: nothing of what is as the list is by itself. */
type Said<Shape extends ListSearchShape> = { [Key in keyof Shape]?: string };

const DEFAULT_TEXT = "";

const fallback = (one: ReadonlyArray<string> | "text") =>
  one === "text" ? DEFAULT_TEXT : (one[0] ?? DEFAULT_TEXT);

/** Reads a shape out of what an address says, taking nothing it does not know. */
const read = (
  shape: ListSearchShape,
  said: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(shape).map(([key, one]) => {
      const value = said[key];
      // An address says numbers as numbers: what was typed is text whatever it looks like.
      const text =
        typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
      return [
        key,
        text !== undefined && (one === "text" || one.includes(text)) ? text : fallback(one),
      ];
    }),
  );

/**
 * What a route keeps of its address for a list: the values the shape knows, and none that
 * is how the list is by itself, so that a list nobody narrowed has a plain address.
 */
export const listSearch =
  <Shape extends ListSearchShape>(shape: Shape) =>
  (said: Record<string, unknown>): Said<Shape> => {
    const values = read(shape, said);
    return Object.fromEntries(
      Object.entries(shape).flatMap(([key, one]) => {
        const value = values[key];
        return value === undefined || value === fallback(one) ? [] : [[key, value]];
      }),
    ) as Said<Shape>;
  };

/**
 * What the list of the page that is shown is narrowed and ordered by, kept in the page's
 * address: it is there again after a reload, along the history and for whoever is given
 * the address. Changing it puts no step into the history: back leaves the list.
 */
export function useListSearch<Shape extends ListSearchShape>(shape: Shape) {
  const said = useRouterState({ select: (state) => state.location.search });
  const navigate = useNavigate();
  const values = read(shape, said) as ListSearch<Shape>;
  const set = (next: Partial<ListSearch<Shape>>) =>
    void navigate({
      to: ".",
      replace: true,
      // What is set back to how the list is by itself is said no more, as it is not read.
      search: ((before: Record<string, unknown>) => {
        const said = { ...before, ...next };
        return {
          ...Object.fromEntries(Object.entries(said).filter(([key]) => !(key in shape))),
          ...listSearch(shape)(said),
        };
      }) as never,
    });
  return [values, set] as const;
}

/** How long nothing is typed before the address says what was typed. */
const SAID_AFTER = 250;

/**
 * Text that is typed and kept in the address: what is typed shows at once, the address
 * says it once the typing rests, and what the address comes to say by itself, as along the
 * history, is what the field then holds.
 */
export function useSearchText(said: string, say: (text: string) => void) {
  const [typed, setTyped] = useState(said);
  const [seen, setSeen] = useState(said);
  /** What this field last had the address say: anything else there came from elsewhere. */
  const sent = useRef(said);

  if (said !== seen) {
    setSeen(said);
    if (said !== sent.current) {
      sent.current = said;
      setTyped(said);
    }
  }

  useEffect(() => {
    if (typed.trim() === sent.current) {
      return undefined;
    }
    const waited = setTimeout(() => {
      sent.current = typed.trim();
      say(sent.current);
    }, SAID_AFTER);
    return () => clearTimeout(waited);
    // Whatever says it is made anew with each render, and says the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typed]);

  return [typed, setTyped] as const;
}
