/**
 * `useClipped` decides whether a `title` attribute is offered at all, and both
 * ways of getting it wrong are invisible in review: always-on means every
 * fully-readable song name grows a redundant OS tooltip a second after the
 * pointer stops, and never-on means the long names — the only ones worth
 * hovering — are the ones with nothing to show.
 *
 * jsdom does no layout, so the measurements are defined here rather than
 * produced. That is not a weaker test than a browser would give: the hook's job
 * is to turn two numbers into a boolean at the right moments, and those moments
 * — mount, a new title, a resize — are exactly what is driven below.
 *
 * No JSX: this file is `.ts` so Node can strip its types with no transform.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useClipped } from "@/lib/hooks/use-clipped";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** What every element on the page currently measures. */
let scrollWidth = 0;
let clientWidth = 0;

function Probe({ title }: { title: string }) {
  const [ref, clipped] = useClipped<HTMLSpanElement>(title);
  return createElement("span", { ref, "data-clipped": String(clipped) }, title);
}

function render(title: string) {
  act(() => {
    root!.render(createElement(Probe, { title }));
  });
}

/** What the component would spread onto `title`: "true" once clipped. */
function clipped(): string {
  return container!.querySelector("span")!.dataset.clipped!;
}

beforeEach(() => {
  scrollWidth = 0;
  clientWidth = 0;
  // On the prototype rather than the node: the hook holds its element through a
  // ref we never see, and a getter here reaches it whatever React hands back.
  for (const [name, read] of [
    ["scrollWidth", () => scrollWidth],
    ["clientWidth", () => clientWidth],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: read });
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root!.unmount());
  container!.remove();
  root = null;
  container = null;
  Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
});

// ---------------------------------------------------------------------------

describe("useClipped", () => {
  it("stays quiet about text that fits", () => {
    scrollWidth = 120;
    clientWidth = 120;
    render("Rocket Man");
    assert.equal(clipped(), "false");
  });

  it("reports text wider than the box it is in", () => {
    scrollWidth = 460;
    clientWidth = 200;
    render("Everything In Its Right Place (Remastered)");
    assert.equal(clipped(), "true");
  });

  it("ignores a single pixel of overflow", () => {
    // Both measurements are rounded to whole pixels, and they round
    // independently — so a line that fits exactly can report one pixel of
    // overflow it does not have. Without this the tooltip appears on titles
    // that are fully on screen, which is the failure nobody reports because it
    // looks deliberate.
    scrollWidth = 201;
    clientWidth = 200;
    render("Rocket Man");
    assert.equal(clipped(), "false");
    // Two is real.
    scrollWidth = 202;
    render("Rocket Man II");
    assert.equal(clipped(), "true");
  });

  it("measures again when the track changes", () => {
    // The element is not replaced between songs — only its text is — so
    // nothing about the DOM tells the hook to look again. Frames arrive every
    // two seconds; a hook that measured only on mount would answer for
    // whichever song happened to be playing when the card first rendered.
    scrollWidth = 120;
    clientWidth = 200;
    render("Rocket Man");
    assert.equal(clipped(), "false");

    scrollWidth = 640;
    render("Everything In Its Right Place (Remastered)");
    assert.equal(clipped(), "true");

    scrollWidth = 90;
    render("Idiot");
    assert.equal(clipped(), "false", "it must fall back as well as forward");
  });

  it("does not crash where ResizeObserver is missing", () => {
    // Which is the environment this test runs in, and also an older browser.
    // The measurement still has to happen; only the resize half is lost.
    assert.equal(typeof globalThis.ResizeObserver, "undefined");
    scrollWidth = 460;
    clientWidth = 200;
    render("Everything In Its Right Place (Remastered)");
    assert.equal(clipped(), "true");
  });
});

describe("useClipped, where the element can be watched", () => {
  /** Every live observer, so the test can resize what the hook is watching. */
  let observers: StubObserver[] = [];

  class StubObserver {
    readonly targets: Element[] = [];
    disconnected = false;
    // A plain field rather than a parameter property: Node runs this file by
    // stripping types, and `private readonly x` in a constructor signature is
    // syntax it would have to rewrite rather than erase.
    readonly callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.push(target);
    }
    unobserve() {}
    disconnect() {
      this.disconnected = true;
    }
    /** What the browser does when the column the title sits in changes width. */
    resize() {
      act(() => this.callback());
    }
  }

  beforeEach(() => {
    observers = [];
    globalThis.ResizeObserver = StubObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  });

  it("re-measures when the element is resized under an unchanged title", () => {
    // Rotating a phone, or dragging a desktop window narrower. The title is the
    // same string it always was, so nothing in React's world has changed and
    // only the observer can notice.
    scrollWidth = 300;
    clientWidth = 400;
    render("Everything In Its Right Place");
    assert.equal(clipped(), "false");

    clientWidth = 200;
    observers[0]!.resize();
    assert.equal(clipped(), "true");
  });

  it("watches the element it measures", () => {
    render("Rocket Man");
    assert.deepEqual(observers[0]!.targets, [container!.querySelector("span")]);
  });

  it("lets the observer go when the element does", () => {
    // The card outlives no element here, but the sheet unmounts on close and a
    // held observer keeps its target alive with it.
    render("Rocket Man");
    const [first] = observers;
    act(() => root!.unmount());
    assert.equal(first!.disconnected, true);
    // Re-created so the next render is not left unwatched, rather than reused.
    root = createRoot(container!);
    render("Tiny Dancer");
    assert.equal(observers.length, 2);
    assert.equal(observers[1]!.disconnected, false);
  });
});
