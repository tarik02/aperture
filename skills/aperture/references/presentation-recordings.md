# Presentation recordings

Read [recordings.md](recordings.md) for recording semantics and [mcp.md](mcp.md) for browser-tool inputs before using this workflow.

A presentation recording teaches a reproduction or feature through visible product actions, then holds on decisive evidence. Aperture owns pointer tempo, burst timing, and camera continuity; the agent owns the story and evidence.

## 1. Storyboard and rehearse

Write the shortest sequence that establishes:

1. the starting state;
2. the user-controlled cause;
3. the observed result;
4. the expected-versus-observed evidence.

Use visible product controls for setup. Use file import only when import behavior is under test. Finish authentication, navigation, viewport sizing, locator inspection, and every focal-gesture rehearsal before recording. Keep the viewport fixed; for canvas or SVG evidence, rehearse viewport coordinates.

The rehearsal is complete when the full sequence succeeds once from a clean starting state and every final proof point has a reliable target or coordinate.

## 2. Start the presentation recording

Start a tab recording with the ready browser target and `presentation: true`. This defaults omitted settings to bursts capture and click ripples. Camera focus is never automatic.

The recording is ready when its status is `running` on the intended browser target and the viewport will remain one size.

## 3. Perform the story

Use one `browser_click` for a visible move, arrival, and click. Give meaningful mutations a short `caption` that states why the step matters. Use `browser_move` only when hover is the action; use `browser_cursor_attention` for passive evidence. Use explicit pointer timing only when a particular action must differ from the recording policy.

For each configuration value:

1. change it through the UI;
2. commit it through the UI;
3. inspect the visible committed state;
4. continue only when the claim is true on screen.

A failed action, retry, uncommitted value, or contradictory caption breaks the take. Failed calls are omitted from the edited presentation and reported as a warning, but remain in the timeline so review must still reject the take.

The interaction pass is complete when every retained action advances the story, every value is committed, and the timeline has no failed or repeated actions.

## 4. Direct attention

Use captions for meaning and `browser_focus_viewport` for camera location. Focus is explicit, camera-only, and belongs to the `recordingId` in the call, so concurrent recordings can use different camera direction. Target either one element with `target`, or a viewport rectangle with `x`, `y`, `width`, and `height`; set `zoom` from 1.1 to 4 and `durationMs` for the complete zoom-in, hold, and zoom-out.

Keep setup at full-page context. Call focus only when a viewer must inspect a compact area: the reproduced defect, a decisive value, or passive evidence that no ordinary action points at. Prefer one focus call that frames all simultaneous evidence. Do not focus every click, use focus as navigation, or alternate zoom-out and zoom-in across adjacent actions.

Give the defect enough inspection time: normally 2000–3000 ms, longer only when the evidence must be read. Focus schedules that interval and returns. When the camera frame is not precise enough, call `browser_cursor_attention` immediately after focus so its separate gesture happens inside the focused interval. Its `target` or `x`/`y` chooses the centre, `radius` controls how tightly it points, and `loops` controls emphasis; prefer two compact loops and keep its duration shorter than the focus. It is real session input, not a recording effect, so every concurrent recording sees it and hover side effects must be safe.

For the final proof, focus the configured value, the conflicting boundary, and the visible defect in consecutive actions. Return to an establishing view and hold it for 1–2 seconds only when the overview adds evidence.

The proof is complete when a silent viewer can name the cause and defect from simultaneous on-screen evidence.

## 5. Stop and review

Stop through MCP or the formal API so Aperture renders the edited recording. Review it from beginning to end and confirm:

- pointer arrival and activation read as one gesture;
- focus appears only where explicitly directed and stays long enough to inspect;
- scrolling into controls, across nested iframe boundaries, and explicit wheel scrolling are smooth;
- captions match simultaneous evidence;
- product reactions finish without unexplained idle gaps;
- the final proof is readable without narration;
- the timeline has no failed actions or retries;
- stop reports an edited path, no edit error, and only understood warnings;
- the media decodes at the intended dimensions.

Deliver the edited recording. Keep the raw recording and timeline for diagnosis.
