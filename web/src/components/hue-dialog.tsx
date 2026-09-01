"use client";

import { ChevronDown, Lightbulb, Loader2, Radio, RotateCw, Router } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { HueArea, HueBridge, NowPlaying, Rgb } from "@/lib/api/types";
import { describeArea, describeBridge, describeHue, type HueTone } from "@/lib/hue-bridge";
import { useErrorToast } from "@/lib/hooks/use-error-toast";
import { useHue, type HueState } from "@/lib/hooks/use-hue";
import { useHueRender, type AnalysisStatus } from "@/lib/hooks/use-hue-render";
import { cn } from "@/lib/utils";

export interface HueDialogProps {
  /** The track the speaker is on. The only thing the render loop reads. */
  nowPlaying: NowPlaying | null;
}

/**
 * The Hue banner, and everything behind it: pairing, picking an area, and
 * starting the lights.
 *
 * ## Why the hooks live here and not in the page
 *
 * `useHue` and `useHueRender` are mounted by this component even though the
 * lights must keep following the music with the dialog shut — which they do,
 * because it is the *trigger* that is always mounted and only `DialogContent`
 * that unmounts on close. Hoisting them to `page.tsx` would move state to a
 * place nothing else reads, and the one thing that genuinely varies with the
 * dialog — whether anybody can see the colour swatch — is `open`, which is
 * local. So `open` is passed down as `preview` and the loop skips publishing to
 * React entirely while nobody is looking.
 */
export function HueDialog({ nowPlaying }: HueDialogProps) {
  const [open, setOpen] = useState(false);
  const hue = useHue();

  const { status, color } = useHueRender({
    nowPlaying,
    streaming: hue.streaming,
    preview: open,
    onStreamLost: hue.reportStreamLost,
  });

  // Only the stream errors toast. `hue.error` is a health or scan failure,
  // which the banner already states and which repeats on every refresh while a
  // bridge reboots; `pairError` is shown inside the dialog because that is
  // where the user is standing when it happens, and because it is instructions
  // rather than an alert.
  useErrorToast(hue.streamError);

  const view = describeHue(hue.health, hue.loading, hue.area?.name);

  /*
   * Scan as soon as the dialog opens on an unpaired bridge.
   *
   * Pairing is done once, ever, and it is the only path into the whole
   * feature — so an empty list behind a Scan button spends the user's first
   * impression on a click that has exactly one sensible answer. Gated on
   * `paired` because a scan is an mDNS sweep plus a possible round trip to
   * Philips, and there is nothing for it to tell someone already set up.
   */
  const paired = hue.health?.paired ?? false;
  const { discover } = hue;
  useEffect(() => {
    if (!open || paired) return;
    discover();
  }, [open, paired, discover]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        aria-haspopup="dialog"
        title="Hue lights"
        className={cn(
          "flex w-full cursor-pointer items-center gap-2.5 rounded-xl border px-4 py-2.5 text-left text-[0.9rem] transition-[background-color,border-color] duration-200",
          TRIGGER_TONE[view.tone],
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
          {view.detail && (
            <span className="text-muted-foreground"> · {view.detail}</span>
          )}
        </span>
        <ChevronDown aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
      </DialogTrigger>

      <DialogContent className="max-h-[80vh] gap-0 min-[601px]:max-h-[85vh]">
        <DialogHeader className="mb-4 shrink-0 flex-row items-center justify-between gap-2 space-y-0">
          <DialogTitle className="flex items-center gap-2 font-display text-[1.15rem] font-semibold">
            <Lightbulb aria-hidden className="size-5 text-gold" />
            Hue lights
          </DialogTitle>
          {/* Sits left of the dialog's own close button, which is absolutely
              positioned in the top-right corner. */}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={paired ? hue.refresh : hue.discover}
            disabled={hue.scanning || hue.pairing}
            aria-label={paired ? "Re-read bridge status" : "Scan for bridges"}
            title={paired ? "Re-read bridge status" : "Scan for bridges"}
            className="mr-8 rounded-full text-muted-foreground"
          >
            <RotateCw className={cn((hue.scanning || hue.loading) && "animate-spin")} />
          </Button>
        </DialogHeader>

        <DialogDescription className="sr-only">
          Pair a Philips Hue bridge and choose which entertainment area follows the music.
        </DialogDescription>

        <div className="thin-scrollbar flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-1.5">
          {paired ? <AreaList hue={hue} /> : <BridgeList hue={hue} />}
        </div>

        {paired && <StreamControls hue={hue} status={status} color={color} />}
      </DialogContent>
    </Dialog>
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
        <Empty>
          No Hue bridge found. Check that it is powered on and on the same LAN
          subnet as this server.
        </Empty>
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
  color,
}: {
  hue: HueState;
  status: AnalysisStatus;
  color: Rgb | null;
}) {
  const ready = hue.area ? describeArea(hue.area, hue.health).ready : false;

  return (
    <div className="mt-4 flex shrink-0 items-center gap-3 border-t border-border pt-4">
      <Swatch color={color} streaming={hue.streaming} />

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
 * The colour on its way to the bridge.
 *
 * Not `aria-live`, and the label does not change with the colour: it updates
 * four times a second and any announcement of it would be a stream of noise.
 * The sentence beside it is what carries the state to a screen reader.
 */
function Swatch({ color, streaming }: { color: Rgb | null; streaming: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-9 shrink-0 rounded-full border transition-colors duration-200",
        streaming ? "border-white/20" : "border-border bg-white/5",
      )}
      style={
        color
          ? {
              backgroundColor: `rgb(${color[0]} ${color[1]} ${color[2]})`,
              boxShadow: `0 0 14px rgb(${color[0]} ${color[1]} ${color[2]} / 0.5)`,
            }
          : undefined
      }
    />
  );
}

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
 */
const TRIGGER_TONE: Record<HueTone, string> = {
  loading: "border-border bg-white/[0.03]",
  setup: "border-border bg-white/[0.03] hover:bg-white/[0.06]",
  ready: "border-gold/20 bg-gold/[0.06] hover:border-gold/35 hover:bg-gold/[0.12]",
  live: "border-gold/20 bg-gold/[0.06] hover:border-gold/35 hover:bg-gold/[0.12]",
  error: "border-[#f87171]/25 bg-[#f87171]/[0.06] hover:bg-[#f87171]/[0.12]",
};

const ICON_TONE: Record<HueTone, string> = {
  loading: "text-muted-foreground",
  setup: "text-muted-foreground",
  ready: "text-gold",
  live: "text-gold",
  error: "text-[#f87171]",
};
