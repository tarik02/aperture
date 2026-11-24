// As much of the browser's extension API as the permission step and what is kept of a
// command touch: storage that is a map, and a prompt whose answer a check sets.

type Kept = Record<string, unknown>;

const area = () => {
  const kept = new Map<string, unknown>();
  return {
    kept,
    get: async (key: string | null) =>
      key === null
        ? (Object.fromEntries(kept) as Kept)
        : kept.has(key)
          ? ({ [key]: kept.get(key) } as Kept)
          : {},
    set: async (items: Kept) => {
      for (const [key, value] of Object.entries(items)) kept.set(key, value);
    },
    remove: async (key: string) => {
      kept.delete(key);
    },
  };
};

export const browser = {
  session: area(),
  local: area(),
  /** The origin patterns the extension has. */
  granted: new Set<string>(),
  /** How the browser's prompt ends: with all that was asked for given, refused, or not put up. */
  prompt: "grant" as "grant" | "refuse" | "reject",
  /** How often the person was asked. */
  asked: 0,
  reset() {
    this.session.kept.clear();
    this.local.kept.clear();
    this.granted.clear();
    this.prompt = "grant";
    this.asked = 0;
  },
};

Object.defineProperty(globalThis, "chrome", {
  configurable: true,
  value: {
    storage: {
      session: browser.session,
      local: browser.local,
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    permissions: {
      request: async ({ origins }: { origins: string[] }) => {
        browser.asked += 1;
        if (browser.prompt === "reject") {
          throw new Error("This function must be called during a user gesture");
        }
        if (browser.prompt === "refuse") return false;
        for (const origin of origins) browser.granted.add(origin);
        return true;
      },
      contains: async ({ origins }: { origins: string[] }) =>
        origins.every((origin) => browser.granted.has(origin)),
    },
  },
});
