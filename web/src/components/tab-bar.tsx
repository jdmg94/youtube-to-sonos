"use client";

import { Lightbulb, ListMusic } from "lucide-react";

import { TABS, TAB_LABEL, type AppTab } from "@/lib/shell";
import { cn } from "@/lib/utils";

/**
 * Phone navigation. Hidden above 900px, where every panel is on screen at once
 * and there is nothing to navigate between.
 *
 * A `tablist` rather than a nav of links: these switch which panels are visible
 * on a single-page client app, they do not change the URL, and calling them
 * links would promise a back button that does not exist.
 *
 * Two tabs, not three. The player is a sheet reached from the row above this
 * bar, because it is the one section you want to reach *without* leaving what
 * you were looking at — pausing a song should not close the queue you were
 * reading. `PANEL_TAB` is where that split is actually stated.
 */
const TAB_ICON: Record<AppTab, typeof ListMusic> = {
  queue: ListMusic,
  lights: Lightbulb,
};

export function TabBar({
  tab,
  onChange,
}: {
  tab: AppTab;
  onChange: (tab: AppTab) => void;
}) {
  return (
    <nav
      aria-label="Sections"
      className={cn(
        "glass-bar fixed inset-x-0 bottom-0 z-40 min-[901px]:hidden",
        // The bar is `--tab-bar` tall and then grows by whatever the home
        // indicator needs, with the same amount as bottom padding — so the
        // buttons stay `--tab-bar` tall and sit above the gesture area rather
        // than under a thumb that is trying to swipe home.
        "h-[calc(var(--tab-bar)+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)]",
      )}
    >
      <div role="tablist" className="flex h-[var(--tab-bar)] items-stretch">
        {TABS.map((id) => (
          <TabButton key={id} id={id} active={id === tab} onSelect={onChange} />
        ))}
      </div>
    </nav>
  );
}

function TabButton({
  id,
  active,
  onSelect,
}: {
  id: AppTab;
  active: boolean;
  onSelect: (tab: AppTab) => void;
}) {
  const Icon = TAB_ICON[id];

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      // `aria-controls` is deliberately absent: the panels this reveals are
      // scattered across two layout columns rather than being one region, and
      // pointing at only one of them would be worse than pointing at none.
      onClick={() => onSelect(id)}
      className={cn(
        "flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 text-[0.7rem] font-semibold",
        "transition-colors duration-200",
        active ? "text-gold" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {/* The colour change alone is a 3:1 shift between two greyish tones on a
          dark bar. The lit pill behind the active icon is what makes the
          current tab legible at a glance and in sunlight. */}
      <span
        className={cn(
          "flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200",
          active && "bg-gold/[0.14]",
        )}
      >
        <Icon aria-hidden className="size-[1.15rem]" />
      </span>
      {TAB_LABEL[id]}
    </button>
  );
}
