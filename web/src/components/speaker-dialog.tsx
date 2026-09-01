"use client";

import { ChevronDown, Disc3, Loader2, RotateCw, Speaker, Waypoints } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ApiError } from "@/lib/api/client";
import type { Device } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export interface SpeakerDialogProps {
  devices: Device[];
  /** A scan is in flight. */
  loading: boolean;
  error: ApiError | null;
  onRefresh: () => void;
  /** The speaker currently being controlled, or null before anything is found. */
  selected: Device | null;
  onSelect: (device: Device) => void;
}

/**
 * The current-speaker banner, which doubles as the trigger that opens the
 * picker.
 *
 * One control, because on this app they are one thought: the only reason to
 * look at which speaker you are controlling is to change it. A separate
 * always-visible speaker list would spend a third of a phone screen on a choice
 * made once a week.
 */
export function SpeakerDialog({
  devices,
  loading,
  error,
  onRefresh,
  selected,
  onSelect,
}: SpeakerDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        // `aria-haspopup` is what tells a screen-reader user this reads as a
        // status but behaves as a menu.
        aria-haspopup="dialog"
        title="Change speaker"
        className={cn(
          "flex w-full cursor-pointer items-center gap-2.5 rounded-xl border px-4 py-2.5 text-left text-[0.9rem] transition-[background-color,border-color] duration-200",
          selected
            ? "border-gold/20 bg-gold/[0.06] hover:border-gold/35 hover:bg-gold/[0.12]"
            : "border-border bg-white/[0.03] hover:bg-white/[0.06]",
        )}
      >
        <Waypoints
          aria-hidden
          className={cn("size-4 shrink-0", selected ? "text-gold" : "text-muted-foreground")}
        />
        {selected ? (
          <span className="min-w-0 truncate text-muted-foreground">
            Controlling <span className="font-semibold text-foreground">{selected.name}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Select a speaker to start</span>
        )}
        <ChevronDown aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
      </DialogTrigger>

      {/*
       * A bottom sheet on a phone, the centred modal it already was above
       * 900px. Both are the same element: the phone styles are passed as base
       * classes so `cn`'s merge drops the ones they replace (`top-1/2`,
       * `left-1/2`, the two translates, `max-w`), and the desktop layout is put
       * back under `min-[901px]:`, which Tailwind emits after the unprefixed
       * utility it is undoing.
       *
       * `rounded-none rounded-t-3xl` rather than `rounded-t-3xl` alone: the base
       * `rounded-3xl` is the *shorthand*, so leaving it in place would keep the
       * bottom corners round on an edge that is off-screen.
       */}
      <DialogContent
        className={cn(
          "inset-x-0 top-auto bottom-0 max-h-[85vh] max-w-none translate-x-0 translate-y-0 sm:max-w-none",
          "gap-0 rounded-none rounded-t-3xl px-5 pt-3",
          // The sheet's own bottom edge is the screen's, so its padding is the
          // only thing between the last speaker and the home indicator.
          "pb-[calc(1.25rem+env(safe-area-inset-bottom))]",
          "data-open:slide-in-from-bottom data-closed:slide-out-to-bottom",

          "min-[901px]:top-1/2 min-[901px]:bottom-auto min-[901px]:left-1/2 min-[901px]:max-w-[460px]",
          "min-[901px]:-translate-x-1/2 min-[901px]:-translate-y-1/2 min-[901px]:rounded-b-3xl",
          "min-[901px]:px-6 min-[901px]:pt-6 min-[901px]:pb-6",
          "min-[901px]:data-open:slide-in-from-bottom-4 min-[901px]:data-closed:slide-out-to-bottom-4",
        )}
      >
        {/* The affordance that says "drag me down", on the one layout where
            that gesture is what people will try first. It is decoration —
            dismissing still happens through the close button or the scrim. */}
        <span
          aria-hidden
          className="mx-auto mb-3 h-1 w-9 shrink-0 rounded-full bg-white/20 min-[901px]:hidden"
        />

        <DialogHeader className="mb-4 shrink-0 flex-row items-center justify-between gap-2 space-y-0">
          <DialogTitle className="flex items-center gap-2 font-display text-[1.15rem] font-semibold">
            <Disc3 aria-hidden className="size-5 text-gold" />
            Speakers
          </DialogTitle>
          {/* Sits left of the dialog's own close button, which is absolutely
              positioned in the top-right corner. */}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh speaker list"
            title="Refresh speaker list"
            className="mr-8 rounded-full text-muted-foreground"
          >
            <RotateCw className={cn(loading && "animate-spin")} />
          </Button>
        </DialogHeader>

        <DialogDescription className="sr-only">
          Choose which Sonos speaker on your network this app controls.
        </DialogDescription>

        <div className="thin-scrollbar flex min-h-0 flex-col gap-2.5 overflow-y-auto pr-1.5">
          <SpeakerList
            devices={devices}
            loading={loading}
            error={error}
            selectedIp={selected?.ip ?? null}
            onSelect={(device) => {
              onSelect(device);
              setOpen(false);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SpeakerList({
  devices,
  loading,
  error,
  selectedIp,
  onSelect,
}: {
  devices: Device[];
  loading: boolean;
  error: ApiError | null;
  selectedIp: string | null;
  onSelect: (device: Device) => void;
}) {
  // A failed rescan leaves the previous list in place (see `useDevices`), so
  // the spinner and the error both defer to speakers we can still show: they
  // may well be playing right now, and hiding them would be a lie.
  if (devices.length > 0) {
    return devices.map((device) => (
      <SpeakerCard
        key={device.ip}
        device={device}
        active={device.ip === selectedIp}
        onSelect={onSelect}
      />
    ));
  }

  if (loading) {
    return (
      <Empty>
        <Loader2 aria-hidden className="mr-2 inline size-4 animate-spin align-[-2px]" />
        Scanning local network…
      </Empty>
    );
  }

  if (error) {
    return <Empty tone="error">Scan error: {error.message}</Empty>;
  }

  return (
    <Empty>
      No Sonos speakers found. Ensure they are powered on and on the same LAN subnet.
    </Empty>
  );
}

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

function SpeakerCard({
  device,
  active,
  onSelect,
}: {
  device: Device;
  active: boolean;
  onSelect: (device: Device) => void;
}) {
  return (
    <button
      type="button"
      // `aria-pressed` rather than a radio group: this is a toggle whose "off"
      // state is unreachable — there is no way to control no speaker once one
      // has been found.
      aria-pressed={active}
      onClick={() => onSelect(device)}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-xl border p-[0.7rem_0.85rem] text-left transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]",
        active
          ? "border-gold bg-gold/[0.08] shadow-[0_0_20px_rgba(212,175,55,0.15)]"
          : "border-border bg-card hover:-translate-y-0.5 hover:border-white/20 hover:bg-[rgba(40,54,86,0.5)]",
      )}
    >
      <span
        className={cn(
          "flex size-[38px] shrink-0 items-center justify-center rounded-[10px] transition-all duration-300",
          active ? "bg-gold text-background" : "bg-white/5 text-muted-foreground",
        )}
      >
        <Speaker aria-hidden className="size-[1.1rem]" />
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-[0.95rem] font-semibold">{device.name}</span>
        <span className="text-[0.78rem] text-muted-foreground">{device.ip}</span>
      </span>
    </button>
  );
}
