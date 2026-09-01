# Hue light show: brightness, transition and spread — design

Status: **approved, not yet implemented**
Branch: `feat-hue-support`
Date: 2026-09-01
Follows: `2026-08-31-hue-support-design.md`

## Goal

Three things the light show cannot currently do:

1. **Be dimmed.** The palette's output is fixed. A room lit for a party is the
   only room available.
2. **Be slowed down.** Colour snaps from tick to tick and every beat flash
   decays at one rate. There is no "calm" setting.
3. **Differ between lights.** `set_color` is called with a single `Rgb`, which
   the backend fans out identically to every channel — so an eight-lamp
   entertainment area is an expensive way to own one very large lamp.

The user's framing for (3) was "a gradient of one mood": all lights on the same
colour idea, offset along the hue arc, reading as depth rather than as variety.
Not a chase, not a per-light frequency split.

## What does not change

**Nothing on the backend.** This is worth stating first because it is
surprising, and because it was the finding that set the scope:

* `HueSession.set_color` (`hue.py:518`) already accepts
  `{channel_id: (r, g, b)}` as well as a uniform triple, and `build_frame`
  already addresses channels individually.
* `HueClient.areas` (`hue.py:374`) already returns `positions` — each channel's
  `{x, y, z}` as the bridge reports it.
* `api.hueColor` (`web/src/lib/api/client.ts:347`) is already typed
  `Rgb | Record<string, Rgb>`.

So the wire format, `API.md`, `app.py` and `hue.py` are untouched. The plumbing
for per-channel colour was built in Milestone 1 and has simply never been used.
The only wire-adjacent change is a *type*: `HueArea.positions` is
`Record<string, unknown>` on the client, carrying the comment "Unused today;
the bridge's own map". It stops being unused.

## Where the work goes

The one architectural choice worth recording is **where the fan-out happens**.

**Chosen: the palette stays scalar, and a separate pure step spreads it.**
`lib/hue.ts` answers "what colour is this music, right now" and knows nothing
about rooms, channels or bridges. A second function takes that answer plus the
channel layout and produces the per-channel map.

**Rejected: `colorAt` returns the map.** Fewer moving parts, worse boundaries —
`lib/hue.ts` would have to import the channel list and the position map, which
couples the model of the *music* to the model of the *room*. The two change for
entirely different reasons: the palette changes when the mapping is retuned, the
spread changes when someone moves a lamp. The file is also already 344 lines,
and this would be the change that makes it a place things get added to rather
than a place with a subject.

The practical payoff is testability. The spread can be tested against synthetic
channel positions with no analysis at all, and the palette's existing 606 lines
of tests keep meaning what they meant.

## The palette gains parameters

```ts
export interface PaletteOptions {
  /** Scales the final value. 1 is today's output. */
  brightness: number;
  /** Beat flash decay, as a fraction of the local beat period. */
  beatDecay: number;
  /** Total width of the per-channel hue spread, in degrees. */
  spreadDeg: number;
}
```

Every field is optional at the call site and defaults to the constant it
replaces (`1`, `BEAT_DECAY_FRACTION`, `0`), so existing callers and existing
tests are unchanged — and `spreadDeg: 0` is exactly today's behaviour, which
means "all lights identical" stays reachable from the UI rather than being
designed out.

Options are passed **per call**, not to `createRenderer`. The renderer sorts the
whole brightness series to compute its per-track normalisation — 2,400 values on
a four-minute track — and rebuilding it on every frame of a slider drag would be
absurd. Keying the renderer on the analysis alone keeps the expensive work
per-track where it belongs.

`Renderer` gains `frameAt(t, opts?)` returning the pre-conversion
`{ hue, saturation, value }`; `colorAt(t, opts?)` becomes
`hsvToRgb(frameAt(t, opts))`. The spread needs the hue *as an angle*, and
recovering it from an already-converted `Rgb` would mean a lossy round trip
through an inverse that does not exist for free.

### Brightness scales value, and the slider does not reach zero

Multiplying the final value preserves contrast proportionally, so a dimmed room
still visibly breathes with the music — the alternative (capping the ceiling
while `MIN_VALUE` holds the floor) squashes dynamics as it dims, and near the
bottom produces a static glow that no longer follows the track at all.

The cost of multiplying is that the bottom of the range approaches invisible,
which collides with the existing rule that lights going out during a quiet
passage read as a crash rather than as atmosphere. This is handled by bounding
the slider's low end rather than by clamping the output, because a clamp would
flatten the dynamics it is trying to protect.

### The arc reduction

This is the subtle part, and it is the reason `spreadDeg` belongs in
`PaletteOptions` rather than being applied afterwards.

`HUE_MIN_DEG`/`HUE_MAX_DEG` stop at 280° for a stated reason: the wheel wraps,
so mapping timbre onto the full 360° would put the brightest sound back on the
same red as the darkest. A naive `hue + offset` reintroduces precisely that
failure — a bright track sitting at 270° with a ±40° spread puts one lamp at
310°, which is magenta on its way back to red, and the two ends of the room
disagree about which end of the track they are lighting.

So the base hue is computed into a **reduced** arc:

```
[HUE_MIN_DEG + spreadDeg/2,  HUE_MAX_DEG − spreadDeg/2]
```

Every channel then lands inside the designed arc by construction, with no
clamping and no special cases. `spreadDeg` is a setting expressed in degrees,
not a fact about the room, so the palette can honour it without learning what a
channel is — the boundary from the previous section holds.

The consequence is real and worth seeing before judging the default: a wide
spread compresses the range the music itself moves through, and at maximum
spread the base hue is pinned to the centre and the room shows a static rainbow.
That is a coherent degenerate case rather than a bug — it is what asking for the
entire arc across the room at once has to mean.

## The spread

```ts
export function orderChannels(
  channels: number[],
  positions: ChannelPositions,
): number[];

export function spreadAcross(
  frame: Frame,
  ordered: number[],
  spreadDeg: number,
): Record<string, Rgb>;
```

Split in two because they have different costs and different lifetimes.
`orderChannels` sorts and is memoised on the channel list and position map;
`spreadAcross` runs per tick and is arithmetic.

**Ordering** ranks channels along whichever of x or y has the larger range. A
room is usually longer in one direction, and picking the wider axis makes the
gradient run along the room rather than across its narrow dimension, where the
extremes would be a metre apart and the effect invisible.

**The fallback matters more than the primary path.** Channel positions have to
be configured in the Hue app, and most people never do it, so the realistic
input is every channel at the origin or at some default. When both axis ranges
are near zero — or a channel's position is missing entirely, which `hue.py:383`
permits by using `.get('position')` — ordering falls back to ascending channel
id. The gradient's spatial coherence is then arbitrary. It is *stably*
arbitrary, which is the property that matters: the same lamp keeps the same
place in the gradient for the whole session, so the room does not reshuffle.

A channel at rank `u ∈ [0,1]` takes `hue + spreadDeg * (u − 0.5)`. A single
channel is at `u = 0.5` and is therefore unshifted, which is the right answer
without a special case.

## Easing

```ts
export function easeToward(
  prev: Rgb, target: Rgb, dtSeconds: number, tauSeconds: number,
): Rgb;
```

Exponential approach, `alpha = 1 − exp(−dt/tau)`.

**Driven by measured `dt`, not a fixed per-tick fraction**, and this is not
style. The send loop uses `setInterval` specifically so that a hidden tab
degrades to roughly 1 Hz instead of stopping — a tab playing music through a
speaker is hidden most of the time. A per-tick alpha would mean a backgrounded
tab smoothed twenty times harder than a visible one, so the lights would go
sluggish exactly when nobody could see why. With `dt`, `alpha` at 1 Hz is near 1
and the loop simply snaps, which is the correct degradation.

`easeChannels` maps over the channel set and eases a newly-appeared channel from
`IDLE_COLOR` rather than snapping it to full — a lamp rejoining the area fades
in.

Easing is deliberately **not** reset on a track change. Easing across the
boundary is the crossfade one would otherwise have to write.

### Interaction with the send threshold

`differsEnough` suppresses sends below a 3/255 step, and heavy smoothing moves
the colour in very small steps — which raises the obvious question of whether a
slow ease can stall below the threshold and freeze the room.

It cannot. `lastSent` only advances when a send *succeeds*, so while the target
keeps moving the gap from `lastSent` keeps growing until it crosses the epsilon.
Heavy smoothing quantises the trajectory into 3-unit steps rather than stopping
it. This is asserted by a test rather than left as an argument.

The map form is `anyDiffersEnough`: a frame is all-or-nothing, so it fires when
*any* channel has moved enough, or when the key set has changed.

## Settings

One `resolveSettings` maps three 0–100 slider positions onto the palette's
units. 0–100 integers rather than 0–1 floats to match `volume-panel.tsx`, and
because they are legible in `localStorage`.

| Slider | Maps to | Range |
|---|---|---|
| Brightness | `brightness` | bounded above zero (see above) |
| Transition | `tauSeconds` **and** `beatDecay` | ~0.02→0.6s, 0.15→0.7 |
| Spread | `spreadDeg` | 0 → 280 |

**Transition drives two constants from one control** because they compose: heavy
smoothing would flatten a short flash into nothing, and lengthening the flash at
the same time is what keeps the beat legible at the languid end. Splitting them
would expose a combination (slow ease, tight flash) whose only outcome is an
invisible beat.

Persisted with `usePersistedState` under `yts.hue.brightness`,
`yts.hue.transition` and `yts.hue.spread`, in a `useHueSettings` hook kept
separate from `useHue` — whose subject is which bridge and which area. Per
browser rather than per room, which two phones would disagree about; only one
tab drives the lights at a time, so it does not surface.

## The render loop

`useHueRender` gains `settings`, `channels` (from `health.channels`, which is
what the stream is actually addressing) and `positions` (from `area.positions`).
All three are read through the existing `latest` ref, so a slider drag does not
tear down and restart the interval — which would reset the failure count and the
last-sent colour with it.

`HueRenderState.color: Rgb | null` becomes `colors: Rgb[] | null`, in room
order, for the dialog's readout.

**Empty-channel safeguard.** If the ordered channel list is empty — health not
yet read, or an area with no channels — the loop sends a uniform `Rgb` as it
does today. An empty map is not equivalent: `build_frame` (`hue.py:441`) fills
unlisted channels with `(0, 0, 0)`, so `{}` would black out the room.

## The dialog

Three sliders in a block between the areas list and the stream controls, in
`volume-panel.tsx`'s idiom (gold range and thumb, `aria-label` on the control,
`aria-hidden` on the numeric readout so it is not announced twice). Shown only
when paired.

They stay **enabled while streaming**, unlike the area rows, which are disabled
because selecting an area mid-stream would be a silent no-op. These are the
opposite case: taking effect live is the entire point.

`Swatch` becomes `SwatchStrip` — one pill per channel in room order, so the
readout shows what is actually being sent rather than a colour no single lamp is
displaying. Still `aria-hidden`; it is decoration, and the status line beside it
carries the meaning.

## Testing

Unit tests for every pure function, which is all of the new logic:

* brightness scales proportionally and preserves hue and saturation
* `hsvToRgb(frameAt(t))` equals `colorAt(t)`
* no spread width can produce a hue outside `[HUE_MIN_DEG, HUE_MAX_DEG]`
* defaults reproduce current output exactly
* degenerate and missing positions fall back to id order; the wider axis wins
* `spreadDeg: 0` yields one identical colour; a single channel is unshifted
* easing is frame-rate independent (one 100ms step ≈ ten 10ms steps)
* a slow ease still crosses the epsilon rather than stalling
* `resolveSettings` is monotonic, exact at the endpoints, and clamps

Hook tests extend `use-hue-render.test.ts`; its fetch mock captures `body.color`
as `Rgb` and needs widening to `Rgb | Record<string, Rgb>`.

`contract-check.ts` gains an assertion in `checkHue`'s paired branch: every
`positions` key is a channel in `channels`, and every value is `{x, y, z}`
numbers or `null`.

## Risks

**None of this can be seen.** No bridge is paired, so the gradient — a purely
visual feature — ships verified only by unit tests. The defaults are reasoned
rather than observed, and should be treated as a first guess.

**The fallback is probably the primary path.** Positions require setup most
people skip, so the spatial gradient likely degrades to id order in practice.
The feature still works; it just stops being spatial, and that should not come
as a surprise later.
