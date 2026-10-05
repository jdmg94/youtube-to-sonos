# Search Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace URL-paste Stream Controller with native YouTube search as a third tab.

**Architecture:** Add `/api/search` backend endpoint using yt-dlp's ytsearch extractor. Add Search tab to SPA navigation (Queue | Search | Settings). SearchPanel component handles search input, results display, and play/queue actions. Auto-navigate to Queue tab after playing.

**Tech Stack:** Backend: Python, Flask, yt-dlp. Frontend: React, Next.js (App Router), TypeScript, Tailwind v4, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-04-search-tab-design.md`

## Global Constraints

- Python 3.12 only (librosa and python-mbedtls compatibility)
- Frontend tests: `pnpm test` must pass
- Frontend typecheck: `pnpm typecheck` must pass
- Frontend lint: `pnpm lint` must pass
- Backend tests: `python -m unittest discover -v` must pass (no new backend tests per project pattern)
- All error messages user-facing (no stack traces)
- Autoplay switch uses same localStorage key as StreamController (`yts.autoplay`)

## Review Focus

1. **Empty search query:** `/api/search?q=` should 400 with clear message, not 500 or hang
2. **Query with no results:** Should return `{"query": "...", "results": []}`, not 404 or error
3. **Null metadata fields:** Frontend must render missing title/uploader/thumbnail gracefully (placeholder, not crash)
4. **Play with no device selected:** SearchPanel should disable play buttons when `device === null`
5. **Tab state persistence:** Switching to Search tab, then away, then back should preserve search results (not clear them)

---

## File Structure

**Backend (Python):**
- Modify: `app.py` - add `/api/search` endpoint around line 2510 (after `/api/info`)
- Modify: `API.md` - document new endpoint around line 120 (after `/api/info` section)

**Frontend (TypeScript/React):**
- Modify: `web/src/lib/api/types.ts` - add `SearchResult`, `SearchResponse`
- Create: `web/src/lib/api/search.ts` - API client for `/api/search`
- Create: `web/src/lib/hooks/use-search.ts` - search state hook
- Create: `web/src/lib/hooks/use-search.test.ts` - hook tests
- Create: `web/src/components/search-panel.tsx` - main search UI
- Modify: `web/src/lib/shell.ts` - add "search" tab and panel
- Modify: `web/src/components/tab-bar.tsx` - add Search icon
- Modify: `web/src/app/page.tsx` - replace StreamController with SearchPanel
- Delete: `web/src/components/stream-controller.tsx`
- Delete: `web/src/lib/hooks/use-stream.ts`
- Delete: `web/src/lib/hooks/use-stream.test.ts`
- Delete: `web/src/lib/stream.ts`
- Delete: `web/src/lib/stream.test.ts`

---

### Task 1: Backend Search Endpoint

**Files:**
- Modify: `app.py:2510` (after `/api/info` endpoint)
- Modify: `API.md:120` (after `/api/info` section)

**Interfaces:**
- Consumes: `ydl_opts()`, `_is_bot_error()`, `_is_forbidden_error()`, `_is_player_error()` (existing helpers)
- Produces: `GET /api/search?q=<query>&limit=<n>` endpoint returning `SearchResponse`

- [ ] **Step 1: Add `/api/search` endpoint to `app.py`**

Insert after `/api/info` endpoint (around line 2510):

```python
@app.route('/api/search', methods=['GET'])
def search():
    query = request.args.get('q', '').strip()
    if not query:
        return jsonify({'error': 'Missing query parameter'}), 400

    limit = request.args.get('limit', '10')
    try:
        limit = max(1, min(20, int(limit)))
    except ValueError:
        limit = 10

    search_url = f"ytsearch{limit}:{query}"

    try:
        with yt_dlp.YoutubeDL(ydl_opts(extract_flat=True)) as ydl:
            info = ydl.extract_info(search_url, download=False)

        results = []
        for entry in (info.get('entries') or []):
            if not entry:
                continue
            results.append({
                'id': entry.get('id'),
                'title': entry.get('title'),
                'uploader': entry.get('uploader') or entry.get('channel'),
                'thumbnail': entry.get('thumbnail'),
                'duration': entry.get('duration'),
            })

        return jsonify({'query': query, 'results': results})

    except yt_dlp.utils.DownloadError as e:
        error_msg = str(e)
        response = {'error': error_msg}

        if _is_bot_error(error_msg):
            response['bot_detected'] = True
            return jsonify(response), 429
        elif _is_forbidden_error(error_msg):
            response['forbidden'] = True
            return jsonify(response), 502
        elif _is_player_error(error_msg):
            response['stale_extractor'] = True
            return jsonify(response), 502
        else:
            return jsonify(response), 500
    except Exception as e:
        logger.exception("Search failed")
        return jsonify({'error': str(e)}), 500
```

- [ ] **Step 2: Test endpoint manually**

Run backend: `make run-local` or `python app.py`

Test successful search:
```bash
curl "http://localhost:5001/api/search?q=never+gonna+give+you+up&limit=3"
```
Expected: 200 with `{"query": "...", "results": [...]}`

Test empty query:
```bash
curl "http://localhost:5001/api/search?q="
```
Expected: 400 with `{"error": "Missing query parameter"}`

Test no results:
```bash
curl "http://localhost:5001/api/search?q=asdfasdfasdfasdfasdf"
```
Expected: 200 with `{"query": "...", "results": []}`

Test limit clamping:
```bash
curl "http://localhost:5001/api/search?q=music&limit=100"
```
Expected: 200 with max 20 results

- [ ] **Step 3: Document endpoint in `API.md`**

Insert after `/api/info` section (around line 120):

```markdown
---

## `GET /api/search`

YouTube search. Returns video results for a query without downloading.

**Query parameters:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `q` | required | Search query string |
| `limit` | 10 | Number of results (1-20, clamped) |

**200**

{
  "query": "string",
  "results": [
    {
      "id": "string",
      "title": "string | null",
      "uploader": "string | null",
      "thumbnail": "string | null",
      "duration": "number | null"
    }
  ]
}

`results` is an empty array when the search finds nothing (not a 404).

**400** missing `q` parameter.
**429/502/500** per the yt-dlp error classes (see top of document).

---
```

- [ ] **Step 4: Commit**

```bash
git add app.py API.md
git commit -m "feat(api): add YouTube search endpoint

Add GET /api/search using yt-dlp's ytsearch extractor.
Returns video metadata without downloading.

- Query parameter: q (required), limit (1-20, default 10)
- Same error handling as /api/info (bot/forbidden/stale flags)
- Returns empty array for no results (not 404)"
```

---

### Task 2: Frontend Type Definitions and API Client

**Files:**
- Modify: `web/src/lib/api/types.ts`
- Create: `web/src/lib/api/search.ts`

**Interfaces:**
- Consumes: Nothing (first frontend task)
- Produces: `SearchResult`, `SearchResponse` types, `searchYouTube()` function

- [ ] **Step 1: Add types to `types.ts`**

Append to `web/src/lib/api/types.ts`:

```typescript
export interface SearchResult {
  id: string;
  title: string | null;
  uploader: string | null;
  thumbnail: string | null;
  duration: number | null;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}
```

- [ ] **Step 2: Create API client `search.ts`**

Create `web/src/lib/api/search.ts`:

```typescript
import type { SearchResponse } from './types';

export async function searchYouTube(
  query: string,
  limit = 10
): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const response = await fetch(`/api/search?${params}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Search failed');
  }

  return response.json();
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/api/types.ts web/src/lib/api/search.ts
git commit -m "feat(api): add search types and client

Add SearchResult and SearchResponse types.
Add searchYouTube() client for /api/search endpoint."
```

---

### Task 3: Search State Hook

**Files:**
- Create: `web/src/lib/hooks/use-search.ts`
- Create: `web/src/lib/hooks/use-search.test.ts`

**Interfaces:**
- Consumes: `searchYouTube()` from `lib/api/search.ts`, `play()` from `lib/api/play.ts` (existing)
- Produces: `useSearch(deviceIp)` hook returning `{ query, setQuery, searching, results, searchError, search(), casting, castError, cast(id, mode), autoplay, setAutoplay }`

- [ ] **Step 1: Write failing test for search state transitions**

Create `web/src/lib/hooks/use-search.test.ts`:

```typescript
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHook, act } from '@testing-library/react';
import { useSearch } from './use-search';

describe('useSearch', () => {
  test('initializes with empty state', () => {
    const { result } = renderHook(() => useSearch(null));

    assert.equal(result.current.query, '');
    assert.equal(result.current.searching, false);
    assert.deepEqual(result.current.results, []);
    assert.equal(result.current.searchError, null);
    assert.equal(result.current.casting, null);
    assert.equal(result.current.castError, null);
  });

  test('updates query on setQuery', () => {
    const { result } = renderHook(() => useSearch(null));

    act(() => {
      result.current.setQuery('test query');
    });

    assert.equal(result.current.query, 'test query');
  });

  test('persists and restores autoplay from localStorage', () => {
    localStorage.setItem('yts.autoplay', 'false');

    const { result } = renderHook(() => useSearch(null));

    assert.equal(result.current.autoplay, false);

    act(() => {
      result.current.setAutoplay(true);
    });

    assert.equal(result.current.autoplay, true);
    assert.equal(localStorage.getItem('yts.autoplay'), 'true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && pnpm test use-search.test.ts
```
Expected: FAIL with "Cannot find module './use-search'"

- [ ] **Step 3: Implement `use-search.ts`**

Create `web/src/lib/hooks/use-search.ts`:

```typescript
import { useState } from 'react';
import { searchYouTube } from '@/lib/api/search';
import { play } from '@/lib/api/play';
import { usePersistedState } from './use-persisted-state';
import type { SearchResult } from '@/lib/api/types';
import type { PlayResponse } from '@/lib/api/types';

const AUTOPLAY_KEY = 'yts.autoplay';

export function useSearch(deviceIp: string | null) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState<Error | null>(null);

  const [casting, setCasting] = useState<string | null>(null);
  const [castError, setCastError] = useState<Error | null>(null);

  const [autoplay, setAutoplay] = usePersistedState(AUTOPLAY_KEY, true);

  async function search() {
    if (!query.trim()) return;

    setSearching(true);
    setSearchError(null);

    try {
      const response = await searchYouTube(query.trim());
      setResults(response.results);
    } catch (error) {
      setSearchError(error as Error);
    } finally {
      setSearching(false);
    }
  }

  async function cast(
    videoId: string,
    mode: 'now' | 'next'
  ): Promise<PlayResponse | null> {
    if (!deviceIp) return null;

    setCasting(videoId);
    setCastError(null);

    try {
      const response = await play({
        url: videoId,
        device_ip: deviceIp,
        autoplay,
        mode,
      });
      return response;
    } catch (error) {
      setCastError(error as Error);
      return null;
    } finally {
      setCasting(null);
    }
  }

  return {
    query,
    setQuery,
    searching,
    results,
    searchError,
    search,
    casting,
    castError,
    cast,
    autoplay,
    setAutoplay,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web && pnpm test use-search.test.ts
```
Expected: PASS (all 3 tests)

- [ ] **Step 5: Add more comprehensive tests**

Add to `use-search.test.ts`:

```typescript
test('clears search error on new search', async () => {
  const { result } = renderHook(() => useSearch('192.168.1.1'));

  // First search fails
  act(() => {
    result.current.setQuery('query1');
  });
  await act(async () => {
    await result.current.search();
  });

  assert.notEqual(result.current.searchError, null);

  // Second search clears error
  act(() => {
    result.current.setQuery('query2');
  });

  act(() => {
    result.current.search();
  });

  assert.equal(result.current.searchError, null);
});

test('handles cast with no device', async () => {
  const { result } = renderHook(() => useSearch(null));

  const response = await act(async () => {
    return await result.current.cast('test-id', 'now');
  });

  assert.equal(response, null);
  assert.equal(result.current.castError, null);
});
```

- [ ] **Step 6: Run full test suite**

```bash
cd web && pnpm test use-search.test.ts
```
Expected: PASS (all 5 tests)

- [ ] **Step 7: Run typecheck**

```bash
cd web && pnpm typecheck
```
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/hooks/use-search.ts web/src/lib/hooks/use-search.test.ts
git commit -m "feat(search): add search state hook

Add useSearch() hook managing search and cast state.
- Search state: query, searching, results, error
- Cast state: casting video ID, error
- Autoplay persisted to localStorage
- Full test coverage (5 tests)"
```

---

### Task 4: SearchPanel Component

**Files:**
- Create: `web/src/components/search-panel.tsx`

**Interfaces:**
- Consumes: `useSearch()` from `lib/hooks/use-search.ts`, `useErrorToast()` from `lib/hooks/use-error-toast.ts`, UI components from `components/ui/*`
- Produces: `<SearchPanel device={Device | null} onNavigateToQueue={() => void} />` component

- [ ] **Step 1: Create SearchPanel component**

Create `web/src/components/search-panel.tsx`:

```typescript
"use client";

import { useEffect, useRef } from 'react';
import { Clock, Infinity as InfinityIcon, Loader2, Play, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { Device } from "@/lib/api/types";
import { useErrorToast } from "@/lib/hooks/use-error-toast";
import { useSearch } from "@/lib/hooks/use-search";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface SearchPanelProps {
  device: Device | null;
  onNavigateToQueue: () => void;
}

export function SearchPanel({ device, onNavigateToQueue }: SearchPanelProps) {
  const search = useSearch(device?.ip ?? null);
  const inputRef = useRef<HTMLInputElement>(null);

  useErrorToast(search.searchError);
  useErrorToast(search.castError);

  async function handleCast(videoId: string, mode: 'now' | 'next') {
    const result = await search.cast(videoId, mode);
    if (result) {
      if (result.status === 'playing') {
        toast.success(`Playing: ${result.title || 'Unknown track'}`);
      } else if (result.queued_next) {
        toast.success(`Queued: ${result.title || 'Unknown track'}`);
      }
      onNavigateToQueue();
    }
  }

  return (
    <div className="flex flex-col">
      <h2 className="mb-6 flex items-center gap-3 font-heading text-xl font-semibold">
        <Search aria-hidden className="size-5 text-brand" />
        Search
      </h2>

      <form
        className="mb-6 flex gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          search.search();
        }}
      >
        <label className="sr-only" htmlFor="search-query">
          Search YouTube
        </label>
        <Input
          ref={inputRef}
          id="search-query"
          type="text"
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          placeholder="Search YouTube (e.g. 'never gonna give you up')"
          autoComplete="off"
          spellCheck={false}
          className="h-auto grow rounded-[14px] border-border bg-white/[0.05] px-5 py-4 text-base transition-all duration-300 focus-visible:border-brand focus-visible:bg-white/[0.08] focus-visible:shadow-[0_0_15px_rgba(255,0,85,0.15)] focus-visible:ring-0 md:text-base"
        />
        <button
          type="submit"
          disabled={!search.query.trim()}
          className={cn(
            "flex shrink-0 cursor-pointer items-center gap-2 rounded-[14px] bg-gradient-to-br from-brand to-brand-strong px-7 py-4 font-semibold text-white",
            "transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] hover:-translate-y-0.5 hover:shadow-[0_6px_20px_rgba(255,0,85,0.4)]",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          {search.searching ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : (
            <Search aria-hidden className="size-4" />
          )}
          Search
        </button>
      </form>

      <label className="mb-5 flex w-fit cursor-pointer select-none items-center gap-[0.6rem] text-[0.85rem] text-muted-foreground">
        <Switch
          checked={search.autoplay}
          onCheckedChange={search.setAutoplay}
          className={cn(
            "h-[22px] w-[38px] px-[3px]",
            "data-checked:border-gold/40 data-checked:bg-gold/25",
            "data-unchecked:border-border data-unchecked:bg-white/[0.12]",
            "[&_[data-slot=switch-thumb]]:size-4 [&_[data-slot=switch-thumb]]:bg-muted-foreground",
            "data-checked:[&_[data-slot=switch-thumb]]:translate-x-4 data-checked:[&_[data-slot=switch-thumb]]:bg-gold",
          )}
        />
        <span className="flex items-center gap-[0.4rem]">
          <InfinityIcon aria-hidden className="size-4 text-gold" />
          Autoplay similar tracks
        </span>
      </label>

      {search.searching && <LoadingState />}

      {!search.searching && search.results.length > 0 && (
        <ResultsList
          results={search.results}
          casting={search.casting}
          disabled={!device}
          onCast={handleCast}
        />
      )}

      {!search.searching && search.results.length === 0 && search.query && (
        <EmptyState query={search.query} />
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex gap-4 rounded-[20px] border border-border bg-card p-4"
        >
          <div className="skeleton aspect-video w-[120px] shrink-0 rounded-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="skeleton h-5 w-4/5" />
            <div className="skeleton h-4 w-1/2" />
            <div className="skeleton h-4 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-[20px] border border-border bg-card p-12 text-center">
      <Search aria-hidden className="size-12 text-muted-foreground/50" />
      <div className="flex flex-col gap-2">
        <p className="text-lg font-semibold">No results for "{query}"</p>
        <p className="text-sm text-muted-foreground">Try a different search term</p>
      </div>
    </div>
  );
}

function ResultsList({
  results,
  casting,
  disabled,
  onCast,
}: {
  results: Array<{
    id: string;
    title: string | null;
    uploader: string | null;
    thumbnail: string | null;
    duration: number | null;
  }>;
  casting: string | null;
  disabled: boolean;
  onCast: (id: string, mode: 'now' | 'next') => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {results.map((result) => (
        <ResultCard
          key={result.id}
          result={result}
          busy={casting === result.id}
          disabled={disabled || casting !== null}
          onCast={onCast}
        />
      ))}
    </div>
  );
}

function ResultCard({
  result,
  busy,
  disabled,
  onCast,
}: {
  result: {
    id: string;
    title: string | null;
    uploader: string | null;
    thumbnail: string | null;
    duration: number | null;
  };
  busy: boolean;
  disabled: boolean;
  onCast: (id: string, mode: 'now' | 'next') => void;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-[20px] border border-border bg-card p-4 transition-all duration-300 hover:border-brand/30 min-[601px]:flex-row">
      <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-xl border border-border shadow-[0_4px_12px_rgba(0,0,0,0.3)] min-[601px]:w-[120px]">
        {result.thumbnail ? (
          <img
            src={result.thumbnail}
            alt=""
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-white/[0.04]">
            <Play aria-hidden className="size-6 text-muted-foreground" />
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="line-clamp-2 font-heading text-base font-semibold leading-[1.4]">
            {result.title || 'Unknown title'}
          </h3>
          <p className="text-sm text-muted-foreground">
            {result.uploader || 'Unknown artist'}
          </p>
        </div>

        {result.duration !== null && (
          <div className="flex items-center gap-1 self-start rounded-md bg-white/[0.08] px-2 py-1 text-xs">
            <Clock aria-hidden className="size-3" />
            {formatDuration(result.duration)}
          </div>
        )}

        <div className="flex flex-col gap-2 min-[601px]:flex-row">
          <button
            type="button"
            onClick={() => onCast(result.id, 'now')}
            disabled={disabled}
            title={disabled && !busy ? "Select a speaker first" : "Play now"}
            className={cn(
              "flex grow-[2] cursor-pointer items-center justify-center gap-2 rounded-[14px] px-4 py-2.5 text-sm font-semibold",
              "bg-gradient-to-br from-gold to-[#b29124] text-[#1a1408] shadow-[0_4px_15px_rgba(212,175,55,0.25)]",
              "transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] hover:-translate-y-0.5 hover:shadow-[0_6px_20px_rgba(212,175,55,0.4)]",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            {busy ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <Play aria-hidden className="size-4" />
            )}
            {busy ? 'Casting…' : 'Play now'}
          </button>

          <button
            type="button"
            onClick={() => onCast(result.id, 'next')}
            disabled={disabled}
            title={disabled && !busy ? "Select a speaker first" : "Play next"}
            className={cn(
              "flex grow cursor-pointer items-center justify-center gap-2 rounded-[14px] border border-border bg-white/[0.08] px-4 py-2.5 text-sm font-semibold",
              "transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] hover:-translate-y-0.5 hover:bg-white/[0.15]",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            {busy ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <Plus aria-hidden className="size-4" />
            )}
            {busy ? 'Queueing…' : 'Play next'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify component compiles**

```bash
cd web && pnpm typecheck
```
Expected: No errors

- [ ] **Step 3: Verify linting passes**

```bash
cd web && pnpm lint
```
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add web/src/components/search-panel.tsx
git commit -m "feat(search): add SearchPanel component

Add search UI with input, results list, and play actions.
- Auto-focus input when panel appears
- Loading state with skeleton cards
- Empty state for no results
- Result cards with thumbnail, metadata, play buttons
- Reuses StreamController styling (gold gradient, glass panels)"
```

---

### Task 5: Tab Navigation Updates

**Files:**
- Modify: `web/src/lib/shell.ts`
- Modify: `web/src/components/tab-bar.tsx`

**Interfaces:**
- Consumes: Nothing (shell updates are self-contained)
- Produces: `"search"` added to `AppTab` and `Panel` types, `TAB_ICON["search"]` added

- [ ] **Step 1: Update shell.ts to add search tab**

Modify `web/src/lib/shell.ts`:

```typescript
// Change AppTab type (line 32)
export type AppTab = "queue" | "search" | "settings";

// Update TABS array (line 35)
export const TABS: readonly AppTab[] = ["queue", "search", "settings"];

// Add to TAB_LABEL (line 37)
export const TAB_LABEL: Record<AppTab, string> = {
  queue: "Queue",
  search: "Search",
  settings: "Settings",
};

// Change Panel type (line 92)
export type Panel = "speaker" | "lights" | "search" | "queue";

// Update PANEL_TAB (line 110)
export const PANEL_TAB: Record<Panel, AppTab> = {
  speaker: "settings",
  lights: "settings",
  search: "search",
  queue: "queue",
};
```

- [ ] **Step 2: Update tab-bar.tsx to add Search icon**

Modify `web/src/components/tab-bar.tsx`:

Add to imports (line 3):
```typescript
import { ListMusic, Search, SlidersHorizontal } from "lucide-react";
```

Update TAB_ICON (line 26):
```typescript
const TAB_ICON: Record<AppTab, typeof ListMusic> = {
  queue: ListMusic,
  search: Search,
  settings: SlidersHorizontal,
};
```

- [ ] **Step 3: Run typecheck**

```bash
cd web && pnpm typecheck
```
Expected: No errors

- [ ] **Step 4: Run tests**

```bash
cd web && pnpm test
```
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/shell.ts web/src/components/tab-bar.tsx
git commit -m "feat(nav): add Search tab to navigation

Add 'search' to AppTab type and TABS array.
Add 'search' Panel mapped to 'search' tab.
Add Search icon to tab bar."
```

---

### Task 6: Integration and Cleanup

**Files:**
- Modify: `web/src/app/page.tsx`
- Delete: `web/src/components/stream-controller.tsx`
- Delete: `web/src/lib/hooks/use-stream.ts`
- Delete: `web/src/lib/hooks/use-stream.test.ts`
- Delete: `web/src/lib/stream.ts`
- Delete: `web/src/lib/stream.test.ts`

**Interfaces:**
- Consumes: `<SearchPanel>` from `components/search-panel.tsx`
- Produces: Fully integrated search tab replacing StreamController

- [ ] **Step 1: Replace StreamController in page.tsx**

Modify `web/src/app/page.tsx`:

Remove import (around line 13):
```typescript
import { StreamController } from "@/components/stream-controller";
```

Add import:
```typescript
import { SearchPanel } from "@/components/search-panel";
```

Replace `<Section panel="stream">` (around line 184):

**Before:**
```tsx
<Section panel="stream" tab={tab} className="p-5 min-[601px]:p-8">
  <StreamController device={selected} />
</Section>
```

**After:**
```tsx
<Section panel="search" tab={tab} className="p-5 min-[601px]:p-8">
  <SearchPanel
    device={selected}
    onNavigateToQueue={() => setTab("queue")}
  />
</Section>
```

- [ ] **Step 2: Delete old StreamController files**

```bash
cd web
rm src/components/stream-controller.tsx
rm src/lib/hooks/use-stream.ts
rm src/lib/hooks/use-stream.test.ts
rm src/lib/stream.ts
rm src/lib/stream.test.ts
```

- [ ] **Step 3: Run typecheck**

```bash
cd web && pnpm typecheck
```
Expected: No errors

- [ ] **Step 4: Run all tests**

```bash
cd web && pnpm test
```
Expected: All tests pass (StreamController tests removed, SearchPanel tests pass)

- [ ] **Step 5: Run lint**

```bash
cd web && pnpm lint
```
Expected: No errors

- [ ] **Step 6: Manual integration test**

Start dev servers:
```bash
make run-local  # Backend on :5001
cd web && pnpm dev  # Frontend on :3000
```

Test flow:
1. Open http://localhost:3000
2. Select a speaker from Settings tab
3. Switch to Search tab
4. Search input should auto-focus
5. Type "never gonna give you up", press Enter
6. Results should appear (10 tracks)
7. Click "Play Now" on first result
8. Should auto-switch to Queue tab
9. Track should start playing
10. Switch back to Search tab
11. Previous search results should still be visible
12. Switch to Settings, then back to Search
13. Search results should persist

- [ ] **Step 7: Test edge cases**

Empty search (should do nothing):
1. Clear search input
2. Press Enter or click Search
3. Nothing should happen

No results:
1. Search for "asdfasdfasdfasdf"
2. Should show empty state: "No results for 'asdfasdfasdfasdf'"

No device selected:
1. Switch to Settings, deselect speaker
2. Switch to Search, search for something
3. Play buttons should be disabled with tooltip "Select a speaker first"

- [ ] **Step 8: Commit**

```bash
git add web/src/app/page.tsx
git add -u  # Stage deletions
git commit -m "feat(search): replace StreamController with SearchPanel

Replace URL-paste StreamController with search tab.
- Add SearchPanel to page.tsx with auto-navigation callback
- Remove StreamController and all related files
- Search tab is middle tab: Queue | Search | Settings

Breaking change: URL paste workflow removed, replaced with search."
```

---

## Final Verification

After all tasks complete:

- [ ] **Backend health check**

```bash
curl http://localhost:5001/api/health
```
Expected: `{"status": "ok", ...}`

- [ ] **Search endpoint check**

```bash
curl "http://localhost:5001/api/search?q=test&limit=5"
```
Expected: `{"query": "test", "results": [...]}`

- [ ] **Frontend build**

```bash
cd web && pnpm build
```
Expected: Build succeeds with no errors

- [ ] **Full test suite**

```bash
cd web && pnpm test && pnpm typecheck && pnpm lint
```
Expected: All pass

- [ ] **Manual E2E test**

Complete user flow from search → play → queue with real speaker

---

## Notes

- Search results are NOT persisted across tab switches (by design - they live in component state)
- Autoplay setting IS persisted (same localStorage key as old StreamController)
- Tab state migration handled by existing `readTab()` - no new code needed
- Search uses same error classification as `/api/info` (bot_detected, forbidden, stale_extractor)
- Frontend follows existing patterns: same styling, same hooks, same error handling
