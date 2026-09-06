"use client";

import { Lightbulb, Loader2, Radar, Radio, RotateCw, Router } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import type { HueArea, HueBridge, NowPlaying, Rgb } from "@/lib/api/types";
import { describeArea, describeBridge, describeHue, type HueTone } from "@/lib/hue-bridge";
import { useErrorToast } from "@/lib/hooks/use-error-toast";
import { useHue, type HueState } from "@/lib/hooks/use-hue";
import { useHueRender, type AnalysisStatus } from "@/lib/hooks/use-hue-render";
import { useHueSettings, type HueSettingsState } from "@/lib/hooks/use-hue-settings";
import { cn } from "@/lib/utils";

export interface LightsPanelProps {
  /** The track the speaker is on. The only thing the render loop reads. */
  nowPlaying: NowPlaying | null;
}

/**
 * Philips Hue: pairing, picking an entertainment area, the three dials, and
 * starting the lights.
 *
 * ## Why this is a panel and not a dialog
 *
 * It was a dialog, because the desktop sidebar had no room for a fourth card.
 * The tabbed shell gives it one: on a phone it is the Lights tab, and above
 * 900px it is a section in the sidebar column. Everything below is the dialog's
 * body, unchanged in behaviour — the pieces it hid behind `DialogContent` are
 * now always mounted.
 *
 * That difference is an improvement rather than a cost. The dialog kept the
 * render loop alive by mounting `useHue` and `useHueRender` on the *trigger*,
 * which stayed rendered while only the content unmounted — a subtlety a reader
 * had to be told about. Here there is nothing to unmount: the shell hides
 * off-tab panels with CSS precisely so state like this survives a tab switch.
 *
 * ## Two deliberate deviations from the dialog
 *
 * `preview` is always on, where the dialog passed `open`. There is no longer a
 * moment when nobody can see the swatch strip on desktop, and the 4 Hz publish
 * that drives it re-renders this subtree only — `useHueRender` is mounted here,
 * so the queue and the stream form above it are untouched. Deriving a real
 * answer would mean a `matchMedia` hook, which is new machinery, an SSR
 * hydration risk, and a saving of a few spans.
 *
 * Scanning is a button, where the dialog scanned on open. A panel has no "open"
 * to hang it on, and the only alternative — scanning on mount — is an mDNS
 * sweep plus a possible round trip to Philips on every page load, for the
 * majority of sessions that have no bridge and never look at this tab.
 */
export function LightsPanel({ nowPlaying }: LightsPanelProps) {
  const hue = useHue();
  const dials = useHueSettings();

  const { status, colors } = useHueRender({
    nowPlaying,
    streaming: hue.streaming,
    preview: true,
    // The area, not just its id: the loop lays the gradient out along the
    // channel list and whatever positions the bridge knows for them.
    area: hue.area,
    settings: dials.resolved,
    onStreamLost: hue.reportStreamLost,
  });

  // Only the stream errors toast. `hue.error` is a health or scan failure,
  // which the header already states and which repeats on every refresh while a
  // bridge reboots; `pairError` is shown in place because that is where the
  // user is looking when it happens, and because it is instructions rather
  // than an alert.
  useErrorToast(hue.streamError);

  const paired = hue.health?.paired ?? false;

  return (
    <div className="flex min-h-0 flex-col gap-2.5">
      <StatusHeader hue={hue} paired={paired} />

      {paired ? (
        <>
          <AreaList hue={hue} />
          <LightSettings dials={dials} />
          <StreamControls hue={hue} status={status} colors={colors} />
        </>
      ) : (
        <BridgeList hue={hue} />
      )}
    </div>
  );
}

/**
 * What the bridge is doing, and the one control that is useful in every state.
 *
 * The dialog put this on its trigger, where a `ChevronDown` promised the rest
 * of the panel was behind it. Here the rest of the panel is directly below, so
 * it is a heading rather than a button — but the wording and the tone treatment
 * are the trigger's, because `describeHue` is what decides both.
 */
function StatusHeader({ hue, paired }: { hue: HueState; paired: boolean }) {
  const view = describeHue(hue.health, hue.loading, hue.area?.name);

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-xl border px-4 py-2.5 text-[0.9rem] transition-[background-color,border-color] duration-200",
        HEADER_TONE[view.tone],
      )}
    >
      <Lightbulb aria-hidden className={cn("size-4 shrink-0", ICON_TONE[view.tone])} />
      <span className="min-w-0 truncate">
        <span
          className={cn(
            "font-semibold",
            view.tone === "loading" || view.tone === "setup"
              ? "text-muted-foreground"
              : "text-foreground",
          )}
        >
          {view.label}
        </span>
        {view.detail && <span className="text-muted-foreground"> · {view.detail}</span>}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={paired ? hue.refresh : hue.discover}
        disabled={hue.scanning || hue.pairing}
        aria-label={paired ? "Re-read bridge status" : "Scan for bridges"}
        title={paired ? "Re-read bridge status" : "Scan for bridges"}
        className="ml-auto shrink-0 rounded-full text-muted-foreground"
      >
        <RotateCw className={cn((hue.scanning || hue.loading) && "animate-spin")} />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

function BridgeList({ hue }: { hue: HueState }) {
  /*
   * The link-button prompt replaces the list rather than sitting under it.
   * Every attempt targets the bridge already chosen, so leaving the other rows
   * live invites a second `pair` that aborts the first — and the user, who is
   * halfway across the house, would have no way to know the walk was wasted.
   */
  if (hue.pairing) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-gold/20 bg-gold/[0.06] px-4 py-8 text-center">
        <Radio aria-hidden className="size-7 animate-pulse text-gold" />
        <p className="text-[0.95rem] font-semibold">Press the button on your Hue bridge</p>
        <p className="max-w-[34ch] text-[0.82rem] text-muted-foreground">
          The big round one on the top. This keeps asking for a minute, so there
          is time to walk over.
        </p>
        <Button variant="outline" size="sm" onClick={hue.cancelPair}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <>
      {hue.pairError && <Empty tone="error">{hue.pairError.message}</Empty>}

      {/* A failed rescan keeps the previous list (see `useHueBridge`), so the
          spinner and the empty state both defer to bridges we can still offer. */}
      {hue.bridges.length > 0 ? (
        hue.bridges.map((bridge) => (
          <BridgeCard key={bridge.ip} bridge={bridge} onPair={() => hue.pair(bridge.ip)} />
        ))
      ) : hue.scanning ? (
        <Empty>
          <Loader2 aria-hidden className="mr-2 inline size-4 animate-spin align-[-2px]" />
          Looking for a Hue bridge…
        </Empty>
      ) : (
        <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
          <p className="max-w-[36ch] text-[0.9rem] text-muted-foreground">
            Pair a Hue bridge to let the lights follow what&rsquo;s playing. It
            has to be powered on and on the same LAN subnet as this server.
          </p>
          {/* The panel's replacement for the dialog's scan-on-open — see the
              note on `LightsPanel`. It is the branch above that keeps a second
              press from starting a second LAN sweep: a scan in flight renders
              the spinner instead of this block, so there is no button to press
              rather than a disabled one to wonder about. */}
          <Button variant="outline" size="sm" onClick={hue.discover}>
            <Radar aria-hidden />
            Scan for bridges
          </Button>
        </div>
      )}
    </>
  );
}

function BridgeCard({ bridge, onPair }: { bridge: HueBridge; onPair: () => void }) {
  const view = describeBridge(bridge);

  return (
    <button
      type="button"
      onClick={onPair}
      className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card p-[0.7rem_0.85rem] text-left transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] hover:-translate-y-0.5 hover:border-white/20 hover:bg-[rgba(40,54,86,0.5)]"
    >
      <span className="flex size-[38px] shrink-0 items-center justify-center rounded-[10px] bg-white/5 text-muted-foreground">
        <Router aria-hidden className="size-[1.1rem]" />
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-[0.95rem] font-semibold">{view.label}</span>
        <span className="truncate text-[0.78rem] text-muted-foreground">{view.detail}</span>
      </span>
      <span className="ml-auto shrink-0 text-[0.8rem] font-medium text-gold">Pair</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

function AreaList({ hue }: { hue: HueState }) {
  if (hue.areas.length === 0) {
    return hue.areasLoading ? (
      <Empty>
        <Loader2 aria-hidden className="mr-2 inline size-4 animate-spin align-[-2px]" />
        Reading entertainment areas…
      </Empty>
    ) : (
      <Empty>
        This bridge has no entertainment areas. Create one in the Philips Hue app
        under Settings → Entertainment areas, then rescan.
      </Empty>
    );
  }

  return (
    <>
      {hue.areas.map((area) => (
        <AreaCard
          key={area.id}
          area={area}
          hue={hue}
          active={hue.area?.id === area.id}
          onSelect={() => hue.selectArea(area.id)}
        />
      ))}
    </>
  );
}

function AreaCard({
  area,
  hue,
  active,
  onSelect,
}: {
  area: HueArea;
  hue: HueState;
  active: boolean;
  onSelect: () => void;
}) {
  const view = describeArea(area, hue.health);

  /*
   * Locked while the lights are running, because `useHue` derives the current
   * area from `health.area` in preference to the saved id whenever a stream is
   * up — so a click here would store a preference, change nothing visible, and
   * leave the highlight where it was. Better to refuse than to no-op.
   */
  const disabled = !view.ready || hue.streaming;

  return (
    <button
      type="button"
      // `aria-pressed`, as in the speaker picker: a toggle whose "off" state is
      // unreachable, since something is always the chosen area.
      aria-pressed={active}
      disabled={disabled}
      onClick={onSelect}
      title={hue.streaming && view.ready ? "Stop the lights to switch area" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-xl border p-[0.7rem_0.85rem] text-left transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]",
        active
          ? "border-gold bg-gold/[0.08] shadow-[0_0_20px_rgba(212,175,55,0.15)]"
          : "border-border bg-card",
        disabled
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer hover:-translate-y-0.5 hover:border-white/20 hover:bg-[rgba(40,54,86,0.5)]",
      )}
    >
      <span
        className={cn(
          "flex size-[38px] shrink-0 items-center justify-center rounded-[10px] transition-all duration-300",
          active ? "bg-gold text-background" : "bg-white/5 text-muted-foreground",
        )}
      >
        <Lightbulb aria-hidden className="size-[1.1rem]" />
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-[0.95rem] font-semibold">{view.label}</span>
        <span className="truncate text-[0.78rem] text-muted-foreground">{view.detail}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// The dials
// ---------------------------------------------------------------------------

/**
 * The three things about the light show a listener can change.
 *
 * Enabled while streaming, unlike the area rows above — which are disabled
 * because picking an area mid-stream would store a preference and change
 * nothing visible. These are the opposite case: taking effect on the next tick
 * is the entire point, and a slider you can only move with the lights off is a
 * slider you have to guess the setting of.
 *
 * "Smoothing" rather than the "transition speed" this started as, because the
 * scale is inverted from what a speed would imply: more of it means slower
 * colour changes and longer beat flashes, and a control labelled speed that
 * slows things down as it goes up is a bug report waiting to happen.
 */
function LightSettings({ dials }: { dials: HueSettingsState }) {
  const { settings } = dials;

  return (
    <div className="mt-0.5 flex flex-col gap-1 rounded-xl border border-border bg-card px-[0.85rem] py-2">
      <Dial label="Brightness" value={settings.brightness} onChange={dials.setBrightness} />
      <Dial label="Smoothing" value={settings.transition} onChange={dials.setTransition} />
      <Dial label="Spread" value={settings.spread} onChange={dials.setSpread} />
    </div>
  );
}

function Dial({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (position: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      {/*
       * `aria-hidden`, with the same word on the slider's own `aria-label`:
       * the text is a visual label for a control that already announces its
       * name and value, and leaving it exposed reads the word twice.
       */}
      <span aria-hidden className="w-[5.5rem] shrink-0 text-[0.8rem] text-muted-foreground">
        {label}
      </span>
      {/* `h-9` on the wrapper for the same reason as the volume panel: the
          track is 6px and the thumb 18px, and the row is what you actually
          hit on a touch screen. */}
      <div className="flex h-9 grow items-center">
        <Slider
          aria-label={label}
          value={[value]}
          min={0}
          max={100}
          step={1}
          onValueChange={([next]) => onChange(next)}
          className={DIAL_CLASS}
        />
      </div>
      <span
        aria-hidden
        className="min-w-[3ch] text-right text-[0.8rem] font-semibold tabular-nums text-gold"
      >
        {value}
      </span>
    </div>
  );
}

/** The volume slider's treatment, on a smaller thumb — three of these stack. */
const DIAL_CLASS = cn(
  "[&_[data-slot=slider-track]]:h-1.5 [&_[data-slot=slider-track]]:bg-white/10",
  "[&_[data-slot=slider-range]]:bg-gold",
  "[&_[data-slot=slider-thumb]]:size-[18px] [&_[data-slot=slider-thumb]]:border-[3px] [&_[data-slot=slider-thumb]]:border-card [&_[data-slot=slider-thumb]]:bg-gold",
  "[&_[data-slot=slider-thumb]]:shadow-[0_0_10px_rgba(212,175,55,0.4)] [&_[data-slot=slider-thumb]]:hover:scale-110",
);

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

/**
 * What the render loop is doing, in the user's terms.
 *
 * `unavailable` gets a sentence rather than a shrug because the lights are
 * still lit and still being driven — they are holding `IDLE_COLOR`. Saying
 * only "no analysis" would leave a warm glow in the room with nothing on
 * screen accounting for it.
 */
const ANALYSIS_NOTE: Record<AnalysisStatus, string> = {
  idle: "Waiting for a track",
  analysing: "Analysing the track…",
  ready: "Following the beat",
  unavailable: "No analysis for this track — holding a warm glow",
};

function StreamControls({
  hue,
  status,
  colors,
}: {
  hue: HueState;
  status: AnalysisStatus;
  colors: Rgb[] | null;
}) {
  const ready = hue.area ? describeArea(hue.area, hue.health).ready : false;

  return (
    <div className="mt-1.5 flex shrink-0 items-center gap-3 border-t border-border pt-4">
      <SwatchStrip colors={colors} streaming={hue.streaming} />

      <span className="min-w-0 flex-1 truncate text-[0.82rem] text-muted-foreground">
        {hue.streaming ? ANALYSIS_NOTE[status] : "Lights are not following"}
      </span>

      <Button
        size="lg"
        variant={hue.streaming ? "outline" : "default"}
        onClick={hue.streaming ? hue.stop : hue.start}
        // Only a start needs an area to be usable. A stop must stay available
        // whatever the area now says, or a stream running against one that has
        // since gone busy or empty could not be turned off from here.
        disabled={hue.busy || (!hue.streaming && !ready)}
      >
        {hue.busy && <Loader2 aria-hidden className="animate-spin" />}
        {hue.streaming ? "Stop" : "Start"}
      </Button>
    </div>
  );
}

/**
 * The colours on their way to the bridge — one segment per light, in room
 * order.
 *
 * A strip rather than a single dot because with the spread dialled up there is
 * no single colour being sent, and averaging them would hide the one thing the
 * readout exists to show. It also makes the spread slider legible without a
 * bridge in the room.
 *
 * Not `aria-live`, and no label changes with the colour: it updates four times
 * a second and any announcement of it would be a stream of noise. The sentence
 * beside it is what carries the state to a screen reader.
 */
function SwatchStrip({ colors, streaming }: { colors: Rgb[] | null; streaming: boolean }) {
  // `[null]` and not an early return: an idle stream and a one-lamp room are
  // the same shape on screen, and the glow is the only thing that differs.
  const lights: (Rgb | null)[] = colors && colors.length > 0 ? colors : [null];
  const glow = lights[Math.floor(lights.length / 2)];

  return (
    <span
      aria-hidden
      className={cn(
        "flex h-9 shrink-0 overflow-hidden rounded-full border transition-colors duration-200",
        lights.length > 1 ? "w-16" : "w-9",
        streaming ? "border-white/20" : "border-border bg-white/5",
      )}
      style={glow ? { boxShadow: `0 0 14px ${rgb(glow, 0.5)}` } : undefined}
    >
      {lights.map((color, i) => (
        <span
          // Index, deliberately: the segments are positions in the room, not
          // identities, and the list only changes length when the area does.
          key={i}
          className="h-full flex-1"
          style={color ? { backgroundColor: rgb(color) } : undefined}
        />
      ))}
    </span>
  );
}

const rgb = ([r, g, b]: Rgb, alpha?: number) =>
  alpha === undefined ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;

// ---------------------------------------------------------------------------

function Empty({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "error";
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "px-4 py-8 text-center text-[0.9rem] italic",
        tone === "error" ? "text-[#f87171]" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

/**
 * One appearance per tone.
 *
 * `ready` and `live` share the gold treatment: both mean the bridge is set up,
 * and the label already distinguishes idle from running. `setup` stays neutral
 * on purpose — it is an invitation, not a warning, and a page with an untouched
 * Hue section should not look like it has a problem.
 *
 * No hover states, unlike the dialog trigger these came from: this is a
 * heading now, and nothing about it is clickable except the refresh button.
 */
const HEADER_TONE: Record<HueTone, string> = {
  loading: "border-border bg-white/[0.03]",
  setup: "border-border bg-white/[0.03]",
  ready: "border-gold/20 bg-gold/[0.06]",
  live: "border-gold/20 bg-gold/[0.06]",
  error: "border-[#f87171]/25 bg-[#f87171]/[0.06]",
};

const ICON_TONE: Record<HueTone, string> = {
  loading: "text-muted-foreground",
  setup: "text-muted-foreground",
  ready: "text-gold",
  live: "text-gold",
  error: "text-[#f87171]",
};
