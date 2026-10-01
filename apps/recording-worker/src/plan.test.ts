import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { buildEditPlan } from "./plan.js";
import type { RenderRequest, Timeline } from "./schema.js";

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends ReadonlyArray<infer Value>
    ? Array<Mutable<Value>>
    : T[Key] extends object
      ? Mutable<T[Key]>
      : T[Key];
};

const effects = (values: Partial<RenderRequest["effects"]> = {}): RenderRequest["effects"] => ({
  idle: "",
  ripple: false,
  burst: null,
  ...values,
});

const build = (...args: Parameters<typeof buildEditPlan>) => Effect.runSync(buildEditPlan(...args));

const timeline = (): Mutable<Timeline> => ({
  version: 1,
  recordingId: "recording",
  video: "recordings/clip.webm",
  durationMs: 10_000,
  segments: [{ targetId: "target", start: 0, end: 10_000, width: 1_280, height: 720 }],
  actions: [],
  gestures: [
    {
      tool: "browser_click",
      targetId: "target",
      start: 1_800,
      end: 2_200,
      hold: 45,
      path: [
        [1_800, 100, 100],
        [2_000, 640, 360],
      ],
      clicks: [{ t: 2_000, x: 640, y: 360, button: "left", count: 1 }],
    },
  ],
  focuses: [],
  activity: { complete: true, spans: [{ start: 1_800, end: 2_400 }] },
});

describe("recording edit planning", () => {
  it("renders only effects requested by the timeline or defaults", () => {
    expect(build(timeline(), effects(), 30)).toBeUndefined();
    expect(build(timeline(), effects({ ripple: true }), 30)?.filter).toContain("geq=");

    const optedOut = timeline();
    optedOut.gestures[0]!.ripple = false;
    expect(build(optedOut, effects({ ripple: true }), 30)).toBeUndefined();
  });

  it("builds one camera scene for each explicit focus", () => {
    const input = timeline();
    input.focuses = [
      {
        targetId: "target",
        start: 1_000,
        end: 3_000,
        x: 500,
        y: 250,
        width: 200,
        height: 100,
        zoom: 2,
      },
      {
        targetId: "target",
        start: 6_000,
        end: 8_500,
        x: 50,
        y: 50,
        width: 200,
        height: 100,
        zoom: 3,
      },
    ];
    expect(build(input, effects(), 30)?.filter.match(/perspective=/gu)).toHaveLength(2);
  });

  it("maps captions onto time after idle is cut", () => {
    const input = timeline();
    input.gestures = [];
    input.activity = { complete: true, spans: [] };
    input.actions = [
      {
        tool: "browser_type",
        targetId: "target",
        start: 7_000,
        end: 7_100,
        caption: "Type {a\\b}\n now",
        ok: true,
      },
    ];
    const plan = build(input, effects({ idle: "cut" }), 30);
    expect(plan?.ass).toContain("Type \\{a＼b\\} now");
    expect(plan?.ass).toContain("Dialogue: 0,0:00:00.30,");
    expect(plan?.filter).toContain("select=");
  });

  it("keeps effect windows inside burst cuts", () => {
    const input = timeline();
    input.actions = [
      {
        tool: "browser_click",
        targetId: "target",
        start: 1_800,
        end: 2_200,
        caption: "Click",
        ok: true,
      },
    ];
    input.focuses = [
      {
        targetId: "target",
        start: 1_800,
        end: 2_200,
        x: 560,
        y: 300,
        width: 160,
        height: 120,
        zoom: 2,
      },
    ];
    const plan = build(input, effects({ burst: {} }), 30);
    expect(plan?.filter).toContain("perspective=");
    expect(plan?.filter).toContain("select='gte(t,1.6333)*lt(t,2.9833)'");
    expect(plan?.ass).toContain("0:00:00.15,0:00:01.35");
  });

  it("returns warnings without transcoding when idle cannot be proven", () => {
    const input = timeline();
    input.gestures = [];
    input.activity.complete = false;
    const plan = build(input, effects({ idle: "cut" }), 30);
    expect(plan?.filter).toBe("");
    expect(plan?.warnings).toHaveLength(1);
  });
});
