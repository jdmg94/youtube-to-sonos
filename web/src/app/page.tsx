"use client";

import { toast } from "sonner";

import { AppHeader } from "@/components/app-header";
import { NowPlayingCard } from "@/components/now-playing";
import { QueuePanel } from "@/components/queue-panel";
import { SpeakerDialog } from "@/components/speaker-dialog";
import { StreamController } from "@/components/stream-controller";
import { VolumePanel } from "@/components/volume-panel";
import { useEvents } from "@/lib/hooks/use-events";
import { useSpeaker } from "@/lib/hooks/use-speaker";

/*
 * The shell.
 *
 * A client component all the way down, and deliberately so: every byte on this
 * page comes from a speaker on the LAN over SSE or from a scan the server
 * component could not have run at build time. There is no server data to
 * stream, so the RSC boundary is at the layout and nothing below it pretends
 * otherwise.
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

  return (
    <>
      <AppHeader
        discovery={{ count: devices.length, scanning: loading, failed: error !== null }}
      />

      {/*
       * Bento grid: a fixed sidebar and a fluid main panel above 900px, one
       * stacked column below it. `min-h-0` on the grid and on every child is
       * what lets the panels scroll internally instead of pushing the page
       * taller than the viewport — a flex/grid child defaults to a min-content
       * floor, which silently defeats `overflow-y: auto` further down.
       */}
      <main className="grid w-full min-h-0 max-w-[1200px] flex-1 grid-cols-1 gap-4 px-4 pb-8 [&>*]:min-h-0 min-[601px]:gap-6 min-[601px]:px-6 min-[901px]:grid-cols-[300px_1fr] min-[901px]:pb-6 min-[1201px]:grid-cols-[340px_1fr]">
        {/*
         * On desktop the *column* scrolls, not the queue inside it. The panels
         * above the queue are `shrink-0`, so when the viewport is short
         * something has to give — and with the queue as the only flexible child
         * it gave all of it: measured 53px tall at 1512x780 and 0px at
         * 1280x680, with the page locked and unable to scroll. The queue was
         * unreachable on an ordinary laptop.
         */}
        <div className="thin-scrollbar flex min-h-0 flex-col gap-4 min-[601px]:gap-6 min-[901px]:overflow-y-auto">
          <section className="glass-panel flex shrink-0 flex-col gap-4 p-5">
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
          </section>

          {/*
           * No `min-h-0` here, deliberately, and no `overflow-hidden`. The
           * default `min-height: auto` is the floor that stops this panel being
           * squeezed below its own content; `flex-1` still lets it stretch to
           * fill the column when there is room to spare.
           */}
          <section className="glass-panel flex shrink-0 flex-1 flex-col p-5">
            <QueuePanel device={selected} station={station} />
          </section>
        </div>

        <section className="glass-panel flex flex-col p-5 min-[601px]:p-8 min-[901px]:overflow-y-auto">
          <StreamController device={selected} />
        </section>
      </main>

      <footer className="mt-auto w-full shrink-0 border-t border-border p-8 text-center text-[0.85rem] text-muted-foreground">
        YouTube ➔ Sonos Streamer &copy; 2026. Powered by Soco, yt-dlp &amp; FFmpeg.
      </footer>
    </>
  );
}
