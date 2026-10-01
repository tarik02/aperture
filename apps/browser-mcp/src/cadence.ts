import type { ApertureCallContext } from "@aperture-browser/recording/schema";
import type { Motion } from "./motion.ts";

// One policy for the shared physical pointer. Explicit tool inputs take precedence.
export const cadence = {
  immediate: { motion: "instant", dwellMs: 0, holdMs: 0, smoothScroll: false, attentionMs: 0 },
  recorded: { motion: "recorded", dwellMs: 60, holdMs: 45, smoothScroll: true, attentionMs: 1200 },
  presentation: {
    motion: "presentation",
    dwellMs: 150,
    holdMs: 45,
    smoothScroll: true,
    attentionMs: 1800,
  },
} satisfies Record<
  ApertureCallContext["cadence"],
  { motion: Motion; dwellMs: number; holdMs: number; smoothScroll: boolean; attentionMs: number }
>;
