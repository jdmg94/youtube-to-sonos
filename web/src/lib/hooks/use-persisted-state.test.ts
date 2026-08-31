/**
 * `usePersistedState` holds the selected speaker, which is the one setting
 * whose loss the user notices on every visit. It reads an external store
 * during render, so its failure modes are the nasty kind: a hydration mismatch
 * that only shows in production, an unstable snapshot that loops forever, a
 * write that silently does nothing.
 *
 * Every test uses its own key. The memory fallback is module-level with no
 * reset hook, and the one test that fills it does so permanently for its key.
 *
 * No JSX: this file is `.ts` so Node can strip its types with no transform.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  subscriberCount,
  useHydrated,
  usePersistedState,
} from "@/lib/hooks/use-persisted-state";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

let keyCounter = 0;
/** A key no other test has touched. */
function freshKey(): string {
  keyCounter += 1;
  return `test:key:${keyCounter}`;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root!.unmount());
  container!.remove();
  root = null;
  container = null;
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------

describe("usePersistedState", () => {
  it("falls back when nothing is stored", () => {
    const key = freshKey();
    let value: string | null = "unset";
    function Probe() {
      [value] = usePersistedState<string | null>(key, null);
      return null;
    }
    act(() => root!.render(createElement(Probe)));
    assert.equal(value, null);
  });

  it("reads a value written by a previous session", () => {
    const key = freshKey();
    window.localStorage.setItem(key, JSON.stringify("10.0.0.1"));

    let value: string | null = null;
    function Probe() {
      [value] = usePersistedState<string | null>(key, null);
      return null;
    }
    act(() => root!.render(createElement(Probe)));
    // On the first client render, not after an effect: a speaker that appears
    // one frame late is a frame of "no speaker selected", and the app would
    // start a discovery scan for a speaker it already knows.
    assert.equal(value, "10.0.0.1");
  });

  it("persists a write and reports it back", () => {
    const key = freshKey();
    let value: string | null = null;
    let set: (v: string | null) => void = () => {};
    function Probe() {
      [value, set] = usePersistedState<string | null>(key, null);
      return null;
    }
    act(() => root!.render(createElement(Probe)));

    act(() => set("10.0.0.2"));
    assert.equal(value, "10.0.0.2");
    assert.equal(window.localStorage.getItem(key), JSON.stringify("10.0.0.2"));
  });

  it("supports a functional update", () => {
    const key = freshKey();
    let value = 0;
    let set: (v: number | ((prev: number) => number)) => void = () => {};
    function Probe() {
      [value, set] = usePersistedState<number>(key, 0);
      return null;
    }
    act(() => root!.render(createElement(Probe)));

    act(() => set((n) => n + 1));
    act(() => set((n) => n + 1));
    assert.equal(value, 2);
  });

  it("treats a corrupt entry as absent instead of crashing the render", () => {
    const key = freshKey();
    window.localStorage.setItem(key, "{not json");

    let value: string | null = "unset";
    function Probe() {
      [value] = usePersistedState<string | null>(key, null);
      return null;
    }
    // A throw here is a blank page for a user who can't clear their own
    // localStorage, over a setting the app could simply forget.
    act(() => root!.render(createElement(Probe)));
    assert.equal(value, null);
  });

  it("keeps two readers of the same key in agreement", () => {
    const key = freshKey();
    let a: string | null = null;
    let b: string | null = null;
    let setA: (v: string | null) => void = () => {};

    function A() {
      [a, setA] = usePersistedState<string | null>(key, null);
      return null;
    }
    function B() {
      [b] = usePersistedState<string | null>(key, null);
      return null;
    }
    act(() => root!.render(createElement("div", null, createElement(A), createElement(B))));

    act(() => setA("10.0.0.3"));
    // The `storage` event fires only in *other* tabs, so without an explicit
    // fan-out the second reader would sit on a stale value until something
    // else happened to re-render it.
    assert.equal(a, "10.0.0.3");
    assert.equal(b, "10.0.0.3");
  });

  it("picks up a change made in another tab", () => {
    const key = freshKey();
    let value: string | null = null;
    function Probe() {
      [value] = usePersistedState<string | null>(key, null);
      return null;
    }
    act(() => root!.render(createElement(Probe)));

    act(() => {
      window.localStorage.setItem(key, JSON.stringify("10.0.0.9"));
      window.dispatchEvent(new Event("storage"));
    });
    assert.equal(value, "10.0.0.9");
  });

  it("still works when localStorage refuses to store anything", () => {
    const key = freshKey();
    const real = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem() {
          throw new Error("storage disabled");
        },
        setItem() {
          throw new Error("storage disabled");
        },
      },
    });

    try {
      let value: string | null = null;
      let set: (v: string | null) => void = () => {};
      function Probe() {
        [value, set] = usePersistedState<string | null>(key, null);
        return null;
      }
      act(() => root!.render(createElement(Probe)));

      act(() => set("10.0.0.4"));
      // Safari private mode, a full quota, storage disabled by policy. Without
      // the in-memory fallback the write appears to succeed and the re-read
      // hands back the old value, so choosing a speaker does nothing at all —
      // silently, and only for the users who can least debug it.
      assert.equal(value, "10.0.0.4");
    } finally {
      Object.defineProperty(window, "localStorage", { configurable: true, value: real });
    }
  });

  it("beats the older value storage kept when it refused the new one", () => {
    // The realistic failure is partial, not total: reads keep working and a
    // quota fills mid-session. Storage is then holding a *stale* entry, and
    // reads prefer storage — so unless the refused write also clears it, the
    // fallback loses to the value it was supposed to replace and the setting
    // silently reverts.
    const key = freshKey();
    const real = window.localStorage;
    real.setItem(key, JSON.stringify("10.0.0.1"));

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => real.getItem(k),
        removeItem: (k: string) => real.removeItem(k),
        setItem() {
          throw new Error("quota exceeded");
        },
      },
    });

    try {
      let value: string | null = null;
      let set: (v: string | null) => void = () => {};
      function Probe() {
        [value, set] = usePersistedState<string | null>(key, null);
        return null;
      }
      act(() => root!.render(createElement(Probe)));
      assert.equal(value, "10.0.0.1");

      act(() => set("10.0.0.2"));
      assert.equal(value, "10.0.0.2");
    } finally {
      Object.defineProperty(window, "localStorage", { configurable: true, value: real });
    }
  });

  it("does not resurrect a value that storage has since been cleared of", () => {
    // The fallback must be a fallback, not a shadow copy of storage. Mirroring
    // every write into it leaves a map nothing invalidates, so clearing site
    // data — or another tab removing the key — is undone on the next read, and
    // the speaker the user just forgot is selected again.
    const key = freshKey();
    let value: string | null = "unset";
    let set: (v: string | null) => void = () => {};
    function Probe() {
      [value, set] = usePersistedState<string | null>(key, null);
      return null;
    }
    act(() => root!.render(createElement(Probe)));

    act(() => set("10.0.0.7"));
    assert.equal(value, "10.0.0.7");

    act(() => {
      window.localStorage.clear();
      window.dispatchEvent(new Event("storage"));
    });
    assert.equal(value, null);
  });

  it("hands back the same object until the stored text actually changes", () => {
    const key = freshKey();
    // A *stored* value is essential: with nothing stored the hook returns the
    // captured fallback, whose identity is stable however carelessly the
    // snapshot is computed. Mutation testing caught this test passing against
    // a deliberately unmemoised parse for exactly that reason.
    window.localStorage.setItem(key, JSON.stringify({ ip: "10.0.0.1" }));

    let renders = 0;
    let value: { ip: string | null } = { ip: "unset" };

    function Probe() {
      renders += 1;
      // The realistic caller: an object literal, new identity each render.
      [value] = usePersistedState<{ ip: string | null }>(key, { ip: null });
      return null;
    }
    // Under StrictMode React renders twice and re-checks the store, which is
    // where an unstable snapshot becomes a render loop rather than a wrong
    // value.
    act(() => root!.render(createElement(StrictMode, null, createElement(Probe))));
    assert.deepEqual(value, { ip: "10.0.0.1" });

    const first = value;
    act(() => root!.render(createElement(StrictMode, null, createElement(Probe))));
    assert.equal(value, first, "re-parsing on every read hands React a new object and loops");
    assert.ok(renders < 20, `render loop: ${renders} renders for two commits`);
  });

  it("unsubscribes on unmount", () => {
    const key = freshKey();
    function Probe() {
      usePersistedState<string | null>(key, null);
      return null;
    }
    const before = subscriberCount();
    act(() => root!.render(createElement(Probe)));
    assert.equal(subscriberCount(), before + 1, "a mounted reader should be subscribed");

    act(() => root!.unmount());
    root = createRoot(container!); // so afterEach has something to unmount

    // Not "no stale update happens" — React drops those on its own, so that
    // assertion passes with the cleanup deleted. The subscriber itself has to
    // be gone, or the set grows by one per mount for the life of the tab.
    assert.equal(subscriberCount(), before, "the subscriber must be removed, not just ignored");
  });

  it("renders the fallback on the server even when a value is stored", () => {
    const key = freshKey();
    window.localStorage.setItem(key, JSON.stringify("10.0.0.5"));

    function Probe() {
      const [value] = usePersistedState<string | null>(key, null);
      return createElement("span", null, String(value));
    }
    // The server has no storage, so its markup must be the fallback. Reading
    // the real value here would produce markup the client immediately
    // contradicts — a hydration mismatch, which React resolves by throwing the
    // server tree away.
    assert.match(renderToStaticMarkup(createElement(Probe)), /<span>null<\/span>/);
  });
});

describe("useHydrated", () => {
  it("is false on the server", () => {
    function Probe() {
      return createElement("span", null, String(useHydrated()));
    }
    assert.match(renderToStaticMarkup(createElement(Probe)), /<span>false<\/span>/);
  });

  it("is true on the client", () => {
    let hydrated = false;
    function Probe() {
      hydrated = useHydrated();
      return null;
    }
    act(() => root!.render(createElement(Probe)));
    assert.equal(hydrated, true);
  });
});
