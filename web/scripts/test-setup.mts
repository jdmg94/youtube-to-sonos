/**
 * Test environment for `node --test`.
 *
 * There is no test framework here on purpose: Node 24 runs TypeScript by
 * stripping types and ships its own runner, so the only thing actually missing
 * for testing React hooks is a DOM. That keeps the toolchain to one
 * devDependency (jsdom) instead of a bundler, a transform and a runner.
 *
 * Loaded with `node --import ./scripts/test-setup.ts`, which is early enough
 * that `react-dom` sees a populated `globalThis` when it is first imported.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { JSDOM } from "jsdom";

// ---------------------------------------------------------------------------
// `@/…` imports
// ---------------------------------------------------------------------------

const SRC = path.resolve(import.meta.dirname, "../src");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    // tsconfig `paths` is a compile-time fiction; Node resolves literally, and
    // it also needs the extension that TypeScript lets us omit.
    const base = path.join(SRC, specifier.slice(2));
    const resolved = existsSync(base) ? base : `${base}.ts`;
    return nextResolve(pathToFileURL(resolved).href, context);
  },
});

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

const globals = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "CustomEvent",
  "MessageEvent",
  "localStorage",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;

for (const name of globals) {
  const value = (dom.window as unknown as Record<string, unknown>)[name];
  if (value !== undefined) {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }
}

// React only runs `act` bookkeeping — the thing that makes effects flush
// synchronously in a test — when it believes it is in a test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
