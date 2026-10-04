/**
 * Test for useSearch hook.
 *
 * No JSX: this file is `.ts` so Node can strip its types with no transform.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useSearch } from './use-search.ts';
import { api } from '@/lib/api/client';
import type { SearchResponse, PlayResponse } from '@/lib/api/types';

/** Must match the key in the hook. */
const AUTOPLAY_KEY = 'yts.autoplay';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let state: ReturnType<typeof useSearch>;

function Probe({ deviceIp }: { deviceIp: string | null }) {
  state = useSearch(deviceIp);
  return null;
}

function render(deviceIp: string | null = null) {
  act(() => root!.render(createElement(Probe, { deviceIp })));
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root!.unmount());
  mock.restoreAll();
  container!.remove();
  root = null;
  container = null;
  window.localStorage.clear();
});

describe('useSearch', () => {
  it('initializes with empty state', () => {
    render(null);

    assert.equal(state.query, '');
    assert.equal(state.searching, false);
    assert.deepEqual(state.results, []);
    assert.equal(state.searchError, null);
    assert.equal(state.casting, null);
    assert.equal(state.castError, null);
  });

  it('updates query on setQuery', () => {
    render(null);

    act(() => {
      state.setQuery('test query');
    });

    assert.equal(state.query, 'test query');
  });

  it('persists and restores autoplay from localStorage', () => {
    localStorage.setItem('yts.autoplay', 'false');

    render(null);

    assert.equal(state.autoplay, false);

    act(() => {
      state.setAutoplay(true);
    });

    assert.equal(state.autoplay, true);
    assert.equal(localStorage.getItem('yts.autoplay'), 'true');
  });

  it('clears search error on new search', async () => {
    // Mock searchYouTube to fail first, then succeed
    let callCount = 0;
    mock.method(globalThis, 'fetch', () => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'Search failed' }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ query: 'query2', results: [] }),
      } as Response);
    });

    render('192.168.1.1');

    // First search fails
    act(() => {
      state.setQuery('query1');
    });

    await act(async () => {
      await state.search();
    });

    assert.notEqual(state.searchError, null);

    // Second search clears error
    act(() => {
      state.setQuery('query2');
    });

    // The search function clears the error when it starts
    await act(async () => {
      await state.search();
    });

    // Error should be cleared (second search succeeded)
    assert.equal(state.searchError, null);
  });

  it('handles cast with no device', async () => {
    render(null);

    const response = await act(async () => {
      return await state.cast('test-id', 'now');
    });

    assert.equal(response, null);
    assert.equal(state.castError, null);
  });
});
