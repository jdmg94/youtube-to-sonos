"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { LightsPanel } from "@/components/lights-panel";
import { NowPlayingCard } from "@/components/now-playing";
import { PlayerBar } from "@/components/player-bar";
import { PlayerSheet } from "@/components/player-sheet";
import { QueuePanel } from "@/components/queue-panel";
import { SpeakerDialog } from "@/components/speaker-dialog";
import { StreamController } from "@/components/stream-controller";
import { TabBar } from "@/components/tab-bar";
import { VolumePanel } from "@/components/volume-panel";
import { useEvents } from "@/lib/hooks/use-events";
import { usePersistedState } from "@/lib/hooks/use-persisted-state";
import { useSpeaker } from "@/lib/hooks/use-speaker";
import {
  DEFAULT_TAB,
  describePlayerBar,
  isAppTab,
  panelVisible,
  type AppTab,
  type Panel,
} from "@/lib/shell";
import { cn } from "@/lib/utils";

const TAB_KEY = "yts.tab";

/*
 * The shell.
 *
 * A client component all the way down, and deliberately so: every byte on this
 * page comes from a speaker on the LAN over SSE or from a scan the server
 * component could not have run at build time. There is no server data to
 * stream, so the RSC boundary is at the layout and nothing below it pretends
 * otherwise.
 *
 * Two layouts, one DOM. Above 900px this is a sidebar and a main column with
 * everything on screen at once; below it three of the four panels are split
 * across two tabs and the fourth — the player — is a sheet that slides over
 * whichever tab is showing. The phone layout is not a second tree — the column
 * wrappers collapse to `display: contents` and the panels for the other tab
 * are hidden — because a second tree would mean two `useEvents` subscriptions
 * polling the same speaker on their own offsets, and a URL half-typed into
 * whichever `StreamController` was not mounted.
 */
export default function Home() {
  const { devices, loading, error, refresh, selected, select } = useSpeaker();

  /*
   * One event stream for the whole page, opened here rather than inside the
   * card that first needed it. The station on these frames drives the queue
   * panel too, and a second `useEvents` would mean a second SSE connection
   * polling the same speaker on its own two-second offset — two panels showing
   * the same track changing at different moments.
   */
  const { nowPlaying, station } = useEvents(selected?.ip ?? null);

  /*
   * Persisted, and validated on the way out. The tab is where someone left the
   * app, and `isAppTab` is what stops a stale value in an older build's storage
   * rendering a phone screen with every panel hidden and no error anywhere —
   * which is exactly what every install carrying the retired `"player"` tab
   * would otherwise do on its next visit.
   */
  const [stored, setTab] = usePersistedState<AppTab>(TAB_KEY, DEFAULT_TAB);
  const tab = isAppTab(stored) ? stored : DEFAULT_TAB;

  /*
   * The player sheet, and deliberately *not* persisted alongside the tab.
   * Where you were browsing is worth restoring; a sheet you opened to skip a
   * track is a transient thing, and reopening the app underneath one is a
   * dialog nobody asked for.
   *
   * `useCallback` because `PlayerSheet` has effects keyed on this — a new
   * identity every render would re-run the media-query listener on every SSE
   * frame.
   */
  const [playerOpen, setPlayerOpen] = useState(false);
  const closePlayer = useCallback(() => setPlayerOpen(false), []);

  const bar = describePlayerBar(nowPlaying, station, selected?.name ?? null);

  return (
    <>
      <AppHeader
        discovery={{ count: devices.length, scanning: loading, failed: error !== null }}
      />

      {/*
       * `min-h-0` on the grid and on every child is what lets the panels scroll
       * internally instead of pushing the page taller than the viewport — a
       * flex/grid child defaults to a min-content floor, which silently defeats
       * `overflow-y: auto` further down.
       */}
      <main className="grid w-full min-h-0 max-w-[1200px] flex-1 grid-cols-1 gap-4 px-4 pb-8 [&>*]:min-h-0 min-[601px]:gap-6 min-[601px]:px-6 min-[901px]:grid-cols-[340px_1fr] min-[901px]:pb-6">
        {/*
         * On desktop the *column* scrolls, not the queue inside it. The panels
         * above are `shrink-0`, so when the viewport is short something has to
         * give — and with the queue as the only flexible child it gave all of
         * it: measured 53px tall at 1512x780 and 0px at 1280x680, with the page
         * locked and unable to scroll. The queue was unreachable on an ordinary
         * laptop.
         *
         * `max-[900px]:contents` is what makes one DOM serve both layouts: on a
         * phone this wrapper stops generating a box and its sections become
         * direct children of the grid above, stacked in source order.
         */}
        <Column>
          {/*
           * The player belongs to no tab: on a phone it is a sheet over
           * whichever one is showing, and here it is the sidebar's first panel
           * exactly as before. `PlayerSheet` is both, which is why it sits in
           * the column rather than beside `PlayerBar` at the end of the page —
           * above 900px this is a `static` element and its position in the DOM
           * is its position on screen.
           */}
          <PlayerSheet open={playerOpen} onClose={closePlayer} className="gap-4">
            <SpeakerDialog
              devices={devices}
              loading={loading}
              error={error}
              onRefresh={refresh}
              selected={selected}
              onSelect={(device) => {
                select(device);
                toast.success(`Selected speaker: ${device.name}`);
              }}
            />
            <NowPlayingCard device={selected} nowPlaying={nowPlaying} station={station} />
            <VolumePanel device={selected} />
          </PlayerSheet>

          {/*
           * Never unmounted, only hidden — the Section below applies a
           * `max-[900px]:hidden` rather than dropping the subtree. That is what
           * keeps the lights running after the listener taps away to the queue:
           * the render loop lives inside this panel, and a tab switch that tore
           * it down would stop the show and leave the bridge on its last frame.
           */}
          <Section panel="lights" tab={tab}>
            <LightsPanel nowPlaying={nowPlaying} />
          </Section>
        </Column>

        <Column>
          <Section panel="stream" tab={tab} className="p-5 min-[601px]:p-8">
            <StreamController device={selected} />
          </Section>

          {/*
           * No `min-h-0` and no `overflow-hidden`. The default `min-height:
           * auto` is the floor that stops this panel being squeezed below its
           * own content; `flex-1` still lets it stretch to fill the column when
           * there is room to spare.
           */}
          <Section panel="queue" tab={tab} className="flex-1">
            <QueuePanel device={selected} station={station} />
          </Section>
        </Column>

        {/*
         * The player bar is `fixed`, so it takes up no room; this reserves its
         * height at the end of the scroll so the last panel's final row is not
         * permanently underneath it. Unconditional now that the bar is — it
         * used to be gated on the same `visible` flag the old mini player was,
         * which was the only thing keeping the two from drifting apart.
         */}
        <div aria-hidden className="h-[var(--player-bar)] min-[901px]:hidden" />
      </main>

      <footer className="mt-auto w-full shrink-0 border-t border-border p-8 text-center text-[0.85rem] text-muted-foreground max-[900px]:hidden">
        YouTube ➔ Sonos Streamer &copy; 2026. Powered by Soco, yt-dlp &amp; FFmpeg.
      </footer>

      <PlayerBar view={bar} expanded={playerOpen} onOpen={() => setPlayerOpen(true)} />
      <TabBar tab={tab} onChange={setTab} />
    </>
  );
}

/**
 * One of the two desktop columns, and nothing at all on a phone.
 *
 * `display: contents` removes the box but keeps the children, which is the
 * whole trick: the grid above lays out four sections in source order on a phone
 * and two columns of two above 900px, from one set of elements.
 */
function Column({ children }: { children: React.ReactNode }) {
  return (
    <div className="thin-scrollbar max-[900px]:contents min-[901px]:flex min-[901px]:min-h-0 min-[901px]:flex-col min-[901px]:gap-6 min-[901px]:overflow-y-auto">
      {children}
    </div>
  );
}

/**
 * A glass panel that knows which phone tab it belongs to.
 *
 * Hidden with CSS rather than unmounted: the Stream controller holds a typed-in
 * URL and the analysis it produced, and unmounting on a tab switch would throw
 * both away — which is exactly what someone does when they paste a link and tap
 * Queue to watch it land.
 */
function Section({
  panel,
  tab,
  className,
  children,
}: {
  panel: Panel;
  tab: AppTab;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "glass-panel flex shrink-0 flex-col p-5",
        !panelVisible(panel, tab) && "max-[900px]:hidden",
        className,
      )}
    >
      {children}
    </section>
  );
}
