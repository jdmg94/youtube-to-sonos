"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";

/**
 * State mirrored into `localStorage`.
 *
 * Storage is an external store, so it is read through `useSyncExternalStore`
 * rather than an effect. That is not ceremony — it is what makes the read
 * hydration-safe (the server snapshot is the fallback, so server and client
 * agree on the first render) while still being a *synchronous* read on every
 * render after, with no flash of the placeholder and no extra render pass.
 * It also makes two open tabs agree, which a Sonos controller will have.
 */

/**
 * Subscribers to notify on a write.
 *
 * The `storage` event only fires in *other* tabs, so a component that writes a
 * key would never learn about its own change. Hence an explicit fan-out.
 */
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

/**
 * How many components are currently subscribed.
 *
 * Introspection, not API — nothing in the app calls this. A subscriber that is
 * never removed is invisible from the outside, because React ignores a store
 * change aimed at an unmounted component; the leak shows up only as a `Set`
 * that grows for the life of the tab, holding a fiber each time. Asserting the
 * unsubscribe *ran* needs to see the set, and mutation testing showed that
 * asserting anything else passes with the `delete` removed.
 */
export function subscriberCount(): number {
  return listeners.size;
}

/**
 * Last-resort store for when `localStorage` throws — Safari in private mode,
 * a full quota, storage disabled by policy. Without it a write would appear to
 * succeed and the next read would hand back the old value, so choosing a
 * speaker would silently do nothing.
 *
 * A key is held here *only* while storage cannot hold it. Mirroring every
 * write instead — the obvious version — makes this map a shadow copy of
 * storage that nothing ever invalidates, so a key removed from `localStorage`
 * (another tab clearing site data, a user clearing history) comes back from
 * memory on the very next read.
 */
const memory = new Map<string, string>();

function readRaw(key: string): string | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) return raw;
  } catch {
    // Fall through to memory.
  }
  return memory.get(key) ?? null;
}

function writeRaw(key: string, raw: string): void {
  try {
    window.localStorage.setItem(key, raw);
    memory.delete(key);
    return;
  } catch {
    // Storage refused the write — fall through.
  }

  memory.set(key, raw);
  // Drop whatever storage still holds for this key. A quota that fills
  // mid-session leaves an *older* value behind, and `readRaw` prefers storage,
  // so leaving it would make the fallback lose to the value it replaced.
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing further to try; the memory copy stands.
  }
}

export function usePersistedState<T>(
  key: string,
  fallback: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  // Captured once, via state rather than a ref because it is read during
  // render. Callers pass object literals, and a fallback whose identity
  // changed every render would make `getServerSnapshot` return a new
  // reference each time, which React treats as an infinite update loop.
  const [initialFallback] = useState(fallback);

  // `getSnapshot` must return a stable reference for unchanged data, so the
  // parse is memoised against the raw string. Parsing on every call would
  // hand React a new object each render and loop forever.
  const cache = useRef<{ raw: string | null; value: T }>({
    raw: null,
    value: initialFallback,
  });

  const getSnapshot = useCallback((): T => {
    const raw = readRaw(key);
    if (raw !== cache.current.raw) {
      let parsed = initialFallback;
      if (raw !== null) {
        try {
          parsed = JSON.parse(raw) as T;
        } catch {
          // Corrupt entry — treat it as absent rather than crashing render.
          parsed = initialFallback;
        }
      }
      cache.current = { raw, value: parsed };
    }
    return cache.current.value;
  }, [key, initialFallback]);

  const getServerSnapshot = useCallback((): T => initialFallback, [initialFallback]);

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      const resolved =
        typeof next === "function" ? (next as (prev: T) => T)(getSnapshot()) : next;
      writeRaw(key, JSON.stringify(resolved));
      notify();
    },
    [key, getSnapshot],
  );

  return [value, update];
}

const neverChanges = () => () => {};

/**
 * Whether React has hydrated.
 *
 * Callers need this to avoid acting on a placeholder: the first render has no
 * access to storage, so a saved speaker reads as "none", and connecting to
 * that would kick off a discovery scan for a speaker we are about to be told
 * the name of.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    neverChanges,
    () => true,
    () => false,
  );
}
