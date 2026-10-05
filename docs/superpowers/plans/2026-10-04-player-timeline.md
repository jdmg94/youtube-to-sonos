# Player Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a display-only timeline to the player card showing current playback position and total duration

**Architecture:** Parse SonosTime strings from the event stream, render a progress bar with time labels, and update every 2 seconds via existing SSE polling

**Tech Stack:** React, TypeScript, Tailwind CSS v4, existing API types

**Spec:** User request to add song duration and current time as a timeline on the player card (display-only, no scrubbing)

## Global Constraints

- Must work with existing `NowPlaying.duration` and `NowPlaying.position` as `SonosTime` strings ("H:MM:SS")
- Updates arrive via `/api/events` SSE stream every 2 seconds; no additional polling
- Timeline is display-only (no seek interaction)
- All text must be in Spanish to match existing UI
- Must handle idle/paused/playing states appropriately
- Must render correctly on both mobile and desktop layouts
- TypeScript strict mode must pass (`pnpm typecheck`)
- All new functions must have unit tests (`pnpm test`)

## Review Focus

1. **Empty/null time strings** — Idle speaker reports `"0:00:00"` for both duration and position; timeline should not render
2. **Hour-length tracks** — A 2-hour ambient upload displays as "2:00:00" / "0:15:23", not truncated
3. **Fractional seconds in SonosTime** — Parser must floor if Sonos ever sends "0:04:41.5"
4. **Position exceeding duration** — During transitions Sonos may report position > duration; progress bar must cap at 100%
5. **Rapid state changes** — TRANSITIONING state between tracks should not flash the timeline in/out

---

### Task 1: SonosTime Parser

**Files:**
- Create: `src/lib/format.ts` (modify existing)
- Test: `src/lib/format.test.ts` (modify existing)

**Interfaces:**
- Consumes: None (pure utility)
- Produces: `parseSonosTime(time: SonosTime | null | undefined): number | null` — converts "H:MM:SS" to seconds, returns null for invalid/zero

- [ ] **Step 1: Write the failing tests**

```typescript
describe("parseSonosTime", () => {
  it("parses a typical track position as seconds", () => {
    assert.equal(parseSonosTime("0:04:41"), 281);
  });

  it("parses hour-length tracks", () => {
    assert.equal(parseSonosTime("2:15:30"), 8130);
  });

  it("treats 0:00:00 as null (idle speaker)", () => {
    assert.equal(parseSonosTime("0:00:00"), null);
  });

  it("handles null and undefined", () => {
    assert.equal(parseSonosTime(null), null);
    assert.equal(parseSonosTime(undefined), null);
  });

  it("floors fractional seconds if present", () => {
    assert.equal(parseSonosTime("0:04:41.5"), 281);
  });

  it("rejects malformed strings", () => {
    assert.equal(parseSonosTime("invalid"), null);
    assert.equal(parseSonosTime("4:41"), null); // missing hours
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/lib/format.test.ts`
Expected: FAIL with "parseSonosTime is not defined"

- [ ] **Step 3: Implement `parseSonosTime(time: SonosTime | null | undefined): number | null` in `src/lib/format.ts`**

Parse "H:MM:SS" using regex `/^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/` to extract hours, minutes, seconds (flooring fractional part). Return `null` for `null`/`undefined`/malformed strings or when total is 0 (idle speaker).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/lib/format.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts
git commit -m "feat: add SonosTime parser for timeline

Parses H:MM:SS strings from Sonos into seconds. Returns null for
idle (0:00:00) or malformed input. Floors fractional seconds."
```

---

### Task 2: Timeline Component

**Files:**
- Create: `src/components/timeline.tsx`
- Test: Not tested (presentational component using already-tested utilities)

**Interfaces:**
- Consumes: `parseSonosTime` from Task 1, `formatDuration` from existing code
- Produces: `<Timeline position={SonosTime | null} duration={SonosTime | null} />` — renders progress bar with time labels

- [ ] **Step 1: Create `src/components/timeline.tsx`**

Component signature:
```typescript
export interface TimelineProps {
  /** Current playback position from NowPlaying, as "H:MM:SS" */
  position: SonosTime | null;
  /** Total track duration from NowPlaying, as "H:MM:SS" */
  duration: SonosTime | null;
}

export function Timeline({ position, duration }: TimelineProps): JSX.Element | null
```

Implementation notes:
- Parse both `position` and `duration` with `parseSonosTime`
- Return `null` (render nothing) if either parse returns `null`
- Calculate progress percentage: `Math.min((positionSeconds / durationSeconds) * 100, 100)` (cap at 100%)
- Render a horizontal bar (Tailwind: `h-1 bg-white/[0.1] rounded-full`) with a filled portion (Tailwind: `bg-brand h-full rounded-full` with `width: ${progress}%`)
- Show two labels: `formatDuration(positionSeconds)` on left, `formatDuration(durationSeconds)` on right
- Use flexbox layout: time labels in a row, progress bar between them
- Spanish label structure: `<div className="flex items-center gap-2 text-xs text-muted-foreground">`

- [ ] **Step 2: Verify component builds**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/timeline.tsx
git commit -m "feat: add Timeline component for playback progress

Display-only progress bar showing position/duration. Renders nothing
when idle. Progress capped at 100% to handle transition edge cases."
```

---

### Task 3: Integrate Timeline into NowPlayingCard

**Files:**
- Modify: `src/components/now-playing.tsx:82-177`

**Interfaces:**
- Consumes: `Timeline` from Task 2, `NowPlaying.position` and `NowPlaying.duration` from props
- Produces: Updated NowPlayingCard with timeline rendered between artwork and title

- [ ] **Step 1: Import Timeline component**

Add to imports at top of `now-playing.tsx`:
```typescript
import { Timeline } from "@/components/timeline";
```

- [ ] **Step 2: Insert Timeline between artwork and title/controls**

Locate the card's main container (line 82-177). Insert `<Timeline>` after the `<Artwork>` element (line 100) and before the equalizer/title section (line 102-132):

```tsx
{view.mode !== "idle" && <Artwork src={artwork} />}

<Timeline position={nowPlaying?.position ?? null} duration={nowPlaying?.duration ?? null} />

<div className="flex min-w-0 items-center gap-[0.85rem]">
```

Position is only shown when `nowPlaying` exists; pass `null` when idle so Timeline handles it.

- [ ] **Step 3: Verify component builds**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Verify linting passes**

Run: `pnpm lint`
Expected: No errors or warnings

- [ ] **Step 5: Start dev server and visually verify timeline**

Run: `pnpm dev`
Navigate to player card with active playback. Verify:
- Timeline appears between artwork and title
- Left label shows current position, right label shows duration
- Progress bar fills proportionally
- Timeline disappears when idle

- [ ] **Step 6: Commit**

```bash
git add src/components/now-playing.tsx
git commit -m "feat: integrate Timeline into NowPlayingCard

Shows playback position between artwork and title. Hidden when idle
via Timeline's own null check on parsed times."
```

---

### Task 4: Add Timeline to PlayerBar (mobile mini-player)

**Files:**
- Modify: `src/components/player-bar.tsx:42-129`

**Interfaces:**
- Consumes: `Timeline` from Task 2, `NowPlaying` from props (need to add to component signature)
- Produces: Updated PlayerBar with timeline below the main row

- [ ] **Step 1: Import Timeline component**

Add to imports at top of `player-bar.tsx`:
```typescript
import { Timeline } from "@/components/timeline";
```

- [ ] **Step 2: Add `nowPlaying` to PlayerBar props**

Modify PlayerBar interface (line 42-56):
```typescript
export function PlayerBar({
  view,
  device,
  nowPlaying,  // Add this
  expanded,
  onOpen,
}: {
  view: PlayerBarView;
  device: Device | null;
  nowPlaying: NowPlaying | null;  // Add this
  expanded: boolean;
  onOpen: () => void;
}) {
```

- [ ] **Step 3: Wrap existing content in a flex column and add Timeline**

The current structure is a single `<div>` with the player row. Wrap it in a container and add Timeline below:

```tsx
<div className={cn(/* existing classes */)}>
  <div className="flex items-center gap-3">
    {/* existing button with thumbnail, title, equalizer */}
    <PlayPause ... />
  </div>

  <Timeline
    position={nowPlaying?.position ?? null}
    duration={nowPlaying?.duration ?? null}
  />
</div>
```

Adjust container classes: change `flex items-center` to `flex flex-col`, add `gap-2` for spacing between row and timeline.

- [ ] **Step 4: Update parent component to pass nowPlaying**

Modify `src/app/page.tsx` where PlayerBar is rendered (search for `<PlayerBar`), add `nowPlaying={nowPlaying}` prop.

- [ ] **Step 5: Verify component builds**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 6: Verify linting passes**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 7: Start dev server and visually verify on mobile layout**

Run: `pnpm dev`
Resize browser to <900px (mobile layout). Verify:
- Timeline appears below player row in bottom bar
- Bar height accommodates both row and timeline
- Timeline updates as track progresses
- Timeline disappears when idle

- [ ] **Step 8: Commit**

```bash
git add src/components/player-bar.tsx src/app/page.tsx
git commit -m "feat: add Timeline to PlayerBar mobile layout

Shows playback progress below the main player row. Hidden when idle.
Wraps content in flex column to stack row and timeline."
```

---

### Task 5: Visual Polish and Edge Cases

**Files:**
- Modify: `src/components/timeline.tsx`

**Interfaces:**
- Consumes: None (refining existing Timeline)
- Produces: Polished Timeline with better styling and ARIA labels

- [ ] **Step 1: Add accessibility label**

Wrap Timeline in a `<div role="timer" aria-label="Posición de reproducción">` so screen readers announce it.

- [ ] **Step 2: Refine visual styling**

Ensure progress bar has smooth fill (use `transition-[width] duration-300` on the filled portion).
Verify text color (`text-muted-foreground`) and bar colors (`bg-white/[0.1]` for track, `bg-brand` for fill) match design system.

- [ ] **Step 3: Handle TRANSITIONING state gracefully**

Timeline should render during TRANSITIONING (track change) since position is still valid. No special handling needed — component already renders whenever both times parse.

- [ ] **Step 4: Verify responsive layout**

Test on both desktop (>900px) and mobile (<900px):
- NowPlayingCard: timeline has adequate spacing, doesn't crowd title
- PlayerBar: timeline fits within bar height, doesn't overlap tab bar

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 6: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/components/timeline.tsx
git commit -m "polish: improve Timeline accessibility and styling

Add ARIA label for screen readers, smooth progress fill transition,
verify responsive layout on mobile and desktop."
```

---

## Implementation Notes

**Why no interpolation between updates?**
The SSE stream updates every 2 seconds. Client-side interpolation (ticking position forward every second) would drift from reality: pausing doesn't emit an instant event, so the timeline would keep advancing for up to 2s after the speaker stopped. Display-only means we show exactly what the speaker reports, no more.

**Why `parseSonosTime` returns `null` for "0:00:00"?**
An idle speaker reports `duration: "0:00:00"` and `position: "0:00:00"`. Parsing these as `0` would render a timeline showing "0:00 / 0:00" with a full progress bar (0/0 = NaN, capped to 100%). Returning `null` makes the timeline disappear entirely, which is correct for idle state.

**Why Timeline renders nothing instead of a skeleton?**
The component is called only when `nowPlaying` exists, but `parseSonosTime` can still return `null` (idle speaker, malformed data). A skeleton would claim playback is imminent when it's not. Rendering nothing is honest.

**Why no seek/scrubbing?**
The existing transport controls (`/api/transport` with `action: "seek"`) support seeking, but the user explicitly requested display-only. Scrubbing would require touch event handling, visual affordances (a draggable thumb), and careful UX around mis-taps skipping to the wrong position. This is a clean v1 that can be upgraded later.
