// lucide v1 dropped brand marks, so the original's YouTube glyph is gone. This
// is the nearest generic shape — a play triangle in a rounded rect — and it
// keeps the wordmark carrying the meaning, which it already did.
import { SquarePlay } from "lucide-react";

export function AppHeader() {
  return (
    <header className="flex w-full max-w-[1200px] shrink-0 items-center justify-between px-4 pt-5 pb-3.5 min-[601px]:px-6 min-[601px]:pt-7 min-[601px]:pb-5">
      <div className="brand-gradient flex items-center gap-3 font-display text-[1.4rem] font-extrabold tracking-[-0.5px] min-[601px]:text-[1.8rem]">
        {/* Not `text-brand`: the icon is inside the gradient-clipped element, so
            it inherits the same red→gold wash as the wordmark. */}
        <SquarePlay aria-hidden className="size-[1.3rem] min-[601px]:size-[1.6rem]" />
        <span>YouTube ➔ Sonos</span>
      </div>
    </header>
  );
}
