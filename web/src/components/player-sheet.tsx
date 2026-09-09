"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The player: a sidebar panel above 900px, a bottom sheet below it.
 *
 * One element for both, the same trick `speaker-dialog.tsx` uses — the phone
 * styles are the *base* classes so `cn`'s merge drops what they replace, and
 * the desktop panel is put back under `min-[901px]:`, which Tailwind emits
 * after the unprefixed utility it is undoing.
 *
 * Deliberately not a Radix `Dialog`, which is what a sheet would normally be.
 * A Dialog mounts its content on open, and neither of the two things in here
 * survives that: `VolumePanel` renders nothing until its first read of the
 * speaker lands, so every open would flash an empty slider, and
 * `NowPlayingCard` holds the `useTrackChange` subscription that raises the
 * "Now playing" toast — a component that only exists while the sheet is open
 * cannot notice a track change while it is closed. Keeping the subtree in the
 * page and moving it with a transform is the same call `page.tsx` already
 * makes for the panels it hides rather than unmounts.
 *
 * The cost of that call is that focus behaviour is hand-rolled below rather
 * than inherited.
 */
export function PlayerSheet({
  open,
  onClose,
  className,
  children,
}: {
  /** Always false above 900px, where this is a panel and not a sheet. */
  open: boolean;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);

  /*
   * Focus in on open, and back where it came from on close.
   *
   * The panel itself takes it rather than the first control: `tabIndex={-1}`
   * plus the `role`/`aria-label` below means a screen reader announces what
   * just opened instead of reading a speaker name out of context.
   */
  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement;
    panel.current?.focus();
    return () => {
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    };
  }, [open]);

  /*
   * The page behind a sheet must not scroll, and this says so with an
   * attribute instead of `body.style.overflow`.
   *
   * The speaker picker one panel over is a Radix dialog, and Radix locks
   * scrolling by writing inline styles on `<body>` and restoring what it found
   * on close. Two owners of one inline property is a race whose loser leaves
   * the page permanently unscrollable; an attribute is a lane nothing else
   * writes to. That the picker no longer sits *inside* this sheet does not
   * retire the argument — both still lock the same one `<body>`. The rule that
   * reads this is scoped to the phone layout, so it cannot lock a desktop page
   * even if `open` is somehow true there.
   */
  useEffect(() => {
    if (!open) return;
    document.body.dataset.playerSheet = "open";
    return () => {
      delete document.body.dataset.playerSheet;
    };
  }, [open]);

  /*
   * Close when the viewport grows past the breakpoint.
   *
   * The one media query in JS, and it is not laying anything out: above 900px
   * the bar that toggles this is `display: none`, so an open sheet becomes a
   * state with no control attached to it. Everything downstream of `open` —
   * `role="dialog"` on what is now a sidebar panel, the scroll lock, the focus
   * trap — is wrong in that state, and closing it is cheaper than teaching
   * each of them the width.
   */
  useEffect(() => {
    if (!open) return;
    const desktop = window.matchMedia("(min-width: 901px)");
    if (desktop.matches) onClose();
    const sync = () => {
      if (desktop.matches) onClose();
    };
    desktop.addEventListener("change", sync);
    return () => desktop.removeEventListener("change", sync);
  }, [open, onClose]);

  return (
    <>
      {/*
       * Above the tab bar (z-40) rather than below it: a scrim that leaves the
       * tabs lit and tappable is not a scrim, it is a shadow. Always rendered
       * so the fade has something to fade, and `invisible` when closed so it
       * cannot swallow a tap on the row underneath.
       */}
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-[45] bg-black/60 transition-[opacity,visibility] duration-300 min-[901px]:hidden",
          open ? "visible opacity-100" : "invisible opacity-0",
        )}
      />

      <section
        ref={panel}
        // Only a dialog when it is one. On desktop this is the sidebar's first
        // panel and `open` is pinned false, so the section keeps the plain
        // semantics it had before there was a sheet at all.
        {...(open ? { role: "dialog", "aria-modal": true, "aria-label": "Player" } : {})}
        tabIndex={open ? -1 : undefined}
        // Read by `.player-sheet` in globals.css, which needs the two states to
        // transition `visibility` differently and cannot get that from a class
        // pair. Named after Radix's own attribute, so that the one sheet on
        // this page which is a Radix dialog — the speaker picker — and the one
        // that is not can be reasoned about with the same vocabulary.
        data-state={open ? "open" : "closed"}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key === "Tab") trapTab(event);
        }}
        className={cn(
          // `player-sheet` carries the slide; see globals.css for why the two
          // transitioned properties cannot be one utility.
          "glass-panel player-sheet flex shrink-0 flex-col p-5",

          "fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto",
          // `glass-panel`'s 65%-alpha surface is calibrated to sit on the page
          // gradient with nothing behind it. A sheet has the whole app behind
          // it, and blurred 35% of white-on-dark queue rows still reads as
          // text. Opaque here, which is also what the speaker picker's own
          // sheet does — it is a Radix dialog, so it gets `bg-background`.
          // A utility beats `@layer components`, so this wins over the class
          // above without either of them saying so; see `.skeleton`'s comment
          // for the time that mechanism was a bug rather than the point.
          "bg-background",
          // `rounded-none` first, because `glass-panel`'s radius is the
          // shorthand: rounding only the top would leave the off-screen bottom
          // corners curved over the edge of the display.
          "rounded-none rounded-t-3xl",
          // This sheet's bottom edge is the screen's, so its padding is all
          // that stands between the volume slider and the home indicator.
          "pb-[calc(1.25rem+env(safe-area-inset-bottom))]",
          open ? "visible translate-y-0" : "invisible translate-y-full",

          "min-[901px]:visible min-[901px]:static min-[901px]:max-h-none",
          "min-[901px]:translate-y-0 min-[901px]:overflow-visible",
          "min-[901px]:rounded-3xl min-[901px]:p-5 min-[901px]:bg-glass",
          className,
        )}
      >
        {/*
         * The sheet's own header, and nothing above the breakpoint. The grab
         * handle is decoration — it matches the speaker picker's, so the two
         * sheets read as the same kind of thing — and the button beside it is
         * the part that actually closes: the scrim is undiscoverable with a
         * keyboard, and Escape is undiscoverable with a thumb.
         */}
        <div className="relative mb-3 flex shrink-0 items-center justify-center min-[901px]:hidden">
          <span aria-hidden className="h-1 w-9 rounded-full bg-white/20" />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close the player"
            className="absolute right-0 -top-1 rounded-full text-muted-foreground"
          >
            <X />
          </Button>
        </div>

        {children}
      </section>
    </>
  );
}

/**
 * Everything a `Tab` press can reach, in the order it reaches them.
 *
 * Deliberately not a `:not([inert])` / visibility-aware selector: the only
 * thing in this sheet that is conditionally hidden is the close button above,
 * and it is hidden on exactly the layout where the trap does not run.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Keep `Tab` inside the sheet.
 *
 * Radix would do this for us, which is the trade the component comment above
 * describes. Without it the next `Tab` out of the volume slider lands on the
 * queue behind the scrim: still focusable, visually covered, and impossible to
 * see what you are about to activate.
 *
 * Nothing in here opens a dialog of its own any more — the speaker picker,
 * which did, has moved out to its own panel — so this trap only ever has the
 * sheet's own controls to walk.
 */
function trapTab(event: KeyboardEvent<HTMLElement>) {
  const panel = event.currentTarget;
  const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getClientRects().length > 0,
  );

  // A sheet whose speaker is still being discovered has no controls at all:
  // `VolumePanel` renders nothing before its first read lands. Parking focus
  // on the panel beats letting Tab fall through to the covered page.
  if (items.length === 0) {
    event.preventDefault();
    panel.focus();
    return;
  }

  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;

  // `active === panel` is the first press after opening, when focus is on the
  // panel itself and neither edge matches.
  if (event.shiftKey && (active === first || active === panel)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
