"use client";

import { Clock, Infinity as InfinityIcon, Loader2, Play, Plus, Search, TowerControl } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { Device } from "@/lib/api/types";
import { useErrorToast } from "@/lib/hooks/use-error-toast";
import { useStream, type AnalyzedVideo, type CastMode } from "@/lib/hooks/use-stream";
import { describeCast, describeVideo } from "@/lib/stream";
import { cn } from "@/lib/utils";

export interface StreamControllerProps {
  /** The speaker the Play buttons target. Analysing works without one. */
  device: Device | null;
}

/**
 * Paste a URL, look it up, send it to the speaker.
 *
 * The info panel sits *above* the URL box rather than below it, which looks
 * backwards until you use the app: the panel is what you act on, so it belongs
 * where your eye already is after pressing Analyze, and the box stays at the
 * bottom ready for the next one.
 *
 * Nothing here paints a now-playing state. A successful cast is reported by a
 * toast and the card above catches up on the next event frame — see
 * `NowPlayingCard` for why the card is never written to from outside the
 * stream.
 */
export function StreamController({ device }: StreamControllerProps) {
  const stream = useStream(device?.ip);

  useErrorToast(stream.analyzeError);
  useErrorToast(stream.castError);

  async function cast(mode: CastMode) {
    const result = await stream.cast(mode);
    if (!result) return;
    const outcome = describeCast(result);
    if (outcome.ok) toast.success(outcome.message);
    else toast.error(outcome.message);
  }

  return (
    <div className="flex flex-col">
      <h2 className="mb-6 flex items-center gap-3 font-heading text-xl font-semibold">
        <TowerControl aria-hidden className="size-5 text-brand" />
        Stream Controller
      </h2>

      {stream.analyzing ? (
        <AnalyzingCard />
      ) : stream.analyzed ? (
        <InfoPanel
          analyzed={stream.analyzed}
          casting={stream.casting}
          disabled={!device}
          onCast={cast}
        />
      ) : null}

      {/*
       * A form so Enter submits natively. The original wired a keypress
       * listener to the input and a click listener to the button, which is the
       * same thing with two ways to get out of sync.
       */}
      <form
        className="mb-6 flex gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          stream.analyze();
        }}
      >
        <label className="sr-only" htmlFor="yt-url">
          YouTube video URL
        </label>
        <Input
          id="yt-url"
          type="text"
          value={stream.url}
          onChange={(event) => stream.setUrl(event.target.value)}
          placeholder="Paste YouTube Video URL (e.g. https://youtu.be/…)"
          autoComplete="off"
          inputMode="url"
          spellCheck={false}
          className="h-auto grow rounded-[14px] border-border bg-white/[0.05] px-5 py-4 text-base transition-all duration-300 focus-visible:border-brand focus-visible:bg-white/[0.08] focus-visible:shadow-[0_0_15px_rgba(255,0,85,0.15)] focus-visible:ring-0 md:text-base"
        />
        <button
          type="submit"
          disabled={!stream.canAnalyze}
          className={cn(
            "flex shrink-0 cursor-pointer items-center gap-2 rounded-[14px] bg-gradient-to-br from-brand to-brand-strong px-7 py-4 font-semibold text-white",
            "transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] hover:-translate-y-0.5 hover:shadow-[0_6px_20px_rgba(255,0,85,0.4)]",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          {stream.analyzing ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : (
            <Search aria-hidden className="size-4" />
          )}
          Analyze
        </button>
      </form>

      <label className="mb-5 flex w-fit cursor-pointer select-none items-center gap-[0.6rem] text-[0.85rem] text-muted-foreground">
        <Switch
          checked={stream.autoplay}
          onCheckedChange={stream.setAutoplay}
          className={cn(
            "h-[22px] w-[38px] px-[3px]",
            "data-checked:border-gold/40 data-checked:bg-gold/25",
            "data-unchecked:border-border data-unchecked:bg-white/[0.12]",
            "[&_[data-slot=switch-thumb]]:size-4 [&_[data-slot=switch-thumb]]:bg-muted-foreground",
            "data-checked:[&_[data-slot=switch-thumb]]:translate-x-4 data-checked:[&_[data-slot=switch-thumb]]:bg-gold",
          )}
        />
        <span className="flex items-center gap-[0.4rem]">
          <InfinityIcon aria-hidden className="size-4 text-gold" />
          Autoplay similar tracks
        </span>
      </label>
    </div>
  );
}

/**
 * The placeholder shown while yt-dlp resolves the URL.
 *
 * Laid out as the panel it is about to become — thumbnail, three bars for
 * title/channel/duration, and the two-button row — so the content arrives in
 * place instead of the panel jumping to a new height under the cursor.
 *
 * Every dimension here is borrowed from the real panel rather than measured
 * off a screenshot: the thumbnail repeats its `aspect-video`/`self-start`/width
 * rules, and the button placeholders carry the real buttons' padding around an
 * invisible label so they inherit the same line box. A hardcoded height would
 * be correct until someone changed a padding step. Only the title's line count
 * can still differ, and that is not knowable before the lookup returns.
 */
function AnalyzingCard() {
  return (
    <div
      role="status"
      aria-label="Analyzing"
      className="mt-4 mb-6 flex flex-col gap-6 rounded-[20px] border border-border bg-card p-6"
    >
      <div className="flex flex-col gap-6 min-[601px]:flex-row">
        <div className="skeleton aspect-video w-full shrink-0 self-start min-[601px]:w-[180px]" />
        <div className="flex grow flex-col justify-center gap-3">
          <div className="skeleton h-5 w-4/5" />
          <div className="skeleton h-[14px] w-1/2" />
          <div className="skeleton h-4 w-[30%]" />
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t border-border pt-6 min-[601px]:flex-row">
        <div aria-hidden className="skeleton grow-[2] rounded-[14px] px-7 py-4">
          <span className="invisible">Play now</span>
        </div>
        <div aria-hidden className="skeleton grow rounded-[14px] px-7 py-4">
          <span className="invisible">Play next</span>
        </div>
      </div>
    </div>
  );
}

function InfoPanel({
  analyzed,
  casting,
  disabled,
  onCast,
}: {
  analyzed: AnalyzedVideo;
  casting: CastMode | null;
  /** No speaker to send to. */
  disabled: boolean;
  onCast: (mode: CastMode) => void;
}) {
  const view = describeVideo(analyzed.info);

  return (
    <div className="mt-4 mb-6 flex animate-in flex-col gap-6 rounded-[20px] border border-border bg-card p-6 fade-in slide-in-from-bottom-2 duration-400">
      <div className="flex flex-col gap-6 min-[601px]:flex-row">
        {/*
         * `self-start` is load-bearing, not tidiness. A flex item stretches to
         * the row's cross size by default, and an explicit stretched height
         * beats `aspect-ratio` — so beside a two-line title the box grew to the
         * text column's height and `object-cover` cropped the artwork by an
         * amount that depended on how long the video's name was.
         */}
        <div className="relative aspect-video w-full shrink-0 self-start overflow-hidden rounded-xl border border-border shadow-[0_8px_16px_rgba(0,0,0,0.4)] min-[601px]:w-[180px]">
          {view.thumbnail ? (
            /*
             * A plain <img>, not next/image. The optimizer would put the Next
             * server between the browser and YouTube's CDN for a picture the
             * browser can already fetch directly — an extra hop on a box whose
             * uplink is busy downloading the audio.
             */
            // eslint-disable-next-line @next/next/no-img-element
            <img src={view.thumbnail} alt="" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center bg-white/[0.04]">
              <Play aria-hidden className="size-6 text-muted-foreground" />
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col justify-center gap-2">
          <div className="font-heading text-xl font-semibold leading-[1.4]">{view.title}</div>
          <div className="text-[0.95rem] text-muted-foreground">{view.uploader}</div>
          <div className="flex items-center gap-1 self-start rounded-md bg-white/[0.08] px-2 py-1 text-[0.85rem]">
            <Clock aria-hidden className="size-[0.85rem]" />
            {view.duration}
          </div>
        </div>
      </div>

      {/*
       * Both buttons go busy for either press. "Play now" tears the station
       * down and rebuilds it, so a "Play next" landing mid-flight would insert
       * into a queue that is about to be cleared.
       */}
      <div className="flex flex-col gap-4 border-t border-border pt-6 min-[601px]:flex-row">
        <CastButton
          mode="now"
          icon={Play}
          label="Play now"
          busyLabel="Casting…"
          casting={casting}
          disabled={disabled}
          onCast={onCast}
          className="grow-[2] bg-gradient-to-br from-gold to-[#b29124] text-[#1a1408] shadow-[0_4px_15px_rgba(212,175,55,0.25)] hover:shadow-[0_6px_20px_rgba(212,175,55,0.4)]"
        />
        <CastButton
          mode="next"
          icon={Plus}
          label="Play next"
          busyLabel="Queueing…"
          casting={casting}
          disabled={disabled}
          onCast={onCast}
          className="grow border border-border bg-white/[0.08] hover:bg-white/[0.15]"
        />
      </div>
    </div>
  );
}

function CastButton({
  mode,
  icon: Icon,
  label,
  busyLabel,
  casting,
  disabled,
  onCast,
  className,
}: {
  mode: CastMode;
  icon: typeof Play;
  label: string;
  busyLabel: string;
  casting: CastMode | null;
  disabled: boolean;
  onCast: (mode: CastMode) => void;
  className: string;
}) {
  const busy = casting === mode;

  return (
    <button
      type="button"
      onClick={() => onCast(mode)}
      disabled={disabled || casting !== null}
      title={disabled ? "Select a speaker first" : label}
      className={cn(
        "flex cursor-pointer items-center justify-center gap-2 rounded-[14px] px-7 py-4 font-semibold",
        "transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] hover:-translate-y-0.5",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
    >
      {busy ? (
        <Loader2 aria-hidden className="size-4 animate-spin" />
      ) : (
        <Icon aria-hidden className="size-4" />
      )}
      {busy ? busyLabel : label}
    </button>
  );
}
