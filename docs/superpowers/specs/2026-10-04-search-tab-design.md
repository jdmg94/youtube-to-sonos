# In-App YouTube Search Design

**Date:** 2026-10-04
**Status:** Approved for implementation
**Author:** Claude Code (with user guidance)

## Overview

Replace the URL-paste Stream Controller with native YouTube search as a third tab in the app. Users search directly within the app, browse results, and play/queue tracks without ever leaving the interface or copying URLs.

## Motivation

**Current workflow problems:**
1. User must leave the app to find a YouTube URL
2. Copy/paste is error-prone and slow on mobile
3. "Analyze" step adds unnecessary friction
4. Stream Controller takes valuable space on Queue tab
5. No browsing - users must know exact URL they want

**New workflow benefits:**
1. Search directly in the app
2. Browse multiple results before choosing
3. One-tap play from search results
4. Dedicated full-screen space for discovery
5. Natural flow: search → play → see queue

## Architecture

### High-Level Design

**Tab Structure:** Queue | Search | Settings (expanded from 2 to 3 tabs)

**Navigation Flow:**
```
User on Queue tab
    ↓
Tap Search tab
    ↓
Search panel appears (full screen on mobile, left column on desktop)
    ↓
Type query, press Enter or Search button
    ↓
Results appear (5-10 tracks)
    ↓
Tap Play Now or Play Next on a result
    ↓
Track starts playing/queueing
    ↓
Auto-navigate back to Queue tab
    ↓
User sees queue with new track
```

### Component Architecture

**Removed:**
- `web/src/components/stream-controller.tsx` - replaced entirely
- `web/src/lib/hooks/use-stream.ts` - search logic is different
- `web/src/lib/hooks/use-stream.test.ts`
- `web/src/lib/stream.ts` - URL analysis logic not needed
- `web/src/lib/stream.test.ts`

**Added:**
- `web/src/components/search-panel.tsx` - main search UI
- `web/src/lib/hooks/use-search.ts` - search state management
- `web/src/lib/hooks/use-search.test.ts` - comprehensive hook tests
- `web/src/lib/api/search.ts` - API client for `/api/search`

**Modified:**
- `web/src/lib/api/types.ts` - add search types
- `web/src/lib/shell.ts` - add "search" tab and panel
- `web/src/components/tab-bar.tsx` - add Search icon
- `web/src/app/page.tsx` - replace StreamController with SearchPanel

## Backend API

### New Endpoint: `GET /api/search`

Searches YouTube and returns video metadata without downloading.

**Request:**
```
GET /api/search?q=never+gonna+give+you+up&limit=10
```

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | required | Search query |
| `limit` | number | 10 | Results count (1-20, clamped) |

**Response (200):**
```json
{
  "query": "never gonna give you up",
  "results": [
    {
      "id": "dQw4w9WgXcQ",
      "title": "Never Gonna Give You Up",
      "uploader": "Rick Astley",
      "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      "duration": 213
    }
  ]
}
```

**Field Details:**

| Field | Type | Nullability | Notes |
|-------|------|-------------|-------|
| `query` | string | never null | Echoed from request |
| `results` | array | never null | Empty array when no results |
| `id` | string | never null | 11-character YouTube video ID |
| `title` | string | nullable | From yt-dlp extraction |
| `uploader` | string | nullable | Channel/artist name |
| `thumbnail` | string | nullable | YouTube CDN URL (direct use) |
| `duration` | number | nullable | Seconds (matches `/api/info`) |

**Error Responses:**

| Status | Body | Meaning |
|--------|------|---------|
| 400 | `{"error": "Missing query parameter"}` | Empty or missing `q` |
| 429 | `{"error": "...", "bot_detected": true}` | Rate limited by YouTube |
| 502 | `{"error": "...", "forbidden": true}` | Media URL 403 (stale extractor) |
| 502 | `{"error": "...", "stale_extractor": true}` | Player session rejected |
| 500 | `{"error": "..."}` | Other failures |

The three boolean flags (`bot_detected`, `forbidden`, `stale_extractor`) match the existing `/api/info` error classification - same handling, same fixes.

### Implementation Details

**File:** `app.py`

**Location:** Add after `/api/info` endpoint (around line 2510)

**Logic:**
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
        # Same error classification as /api/info
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

**Notes:**
- Uses `ydl_opts(extract_flat=True)` - no downloads, just metadata
- Reuses existing `_is_bot_error`, `_is_forbidden_error`, `_is_player_error` helpers
- Same cookie handling as other endpoints (respects `COOKIES_FILE`)
- No caching - search results are ephemeral

### API Documentation

**File:** `API.md`

Add section after `/api/info` (around line 120):

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

## Frontend Implementation

### Type Definitions

**File:** `web/src/lib/api/types.ts`

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

### API Client

**File:** `web/src/lib/api/search.ts`

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

### Search Hook

**File:** `web/src/lib/hooks/use-search.ts`

**Purpose:** Manage search state and orchestrate search → play flow

**State:**
```typescript
interface SearchState {
  query: string;
  setQuery: (query: string) => void;

  searching: boolean;
  results: SearchResult[];
  searchError: Error | null;

  search: () => Promise<void>;

  casting: string | null; // video_id being cast
  castError: Error | null;
  cast: (videoId: string, mode: 'now' | 'next') => Promise<PlayResponse | null>;

  autoplay: boolean;
  setAutoplay: (value: boolean) => void;
}
```

**Behavior:**
- `search()` calls `/api/search` and updates `results`
- `cast()` calls `/api/play` with video ID
- Autoplay persisted to localStorage (same key as StreamController used)
- Errors stored separately for search vs cast (different toasts)

**Testing:** `web/src/lib/hooks/use-search.test.ts`
- Test search success/failure
- Test cast success/failure
- Test autoplay persistence
- Test state transitions (idle → searching → results)

### Search Panel Component

**File:** `web/src/components/search-panel.tsx`

**Props:**
```typescript
interface SearchPanelProps {
  device: Device | null;
  onNavigateToQueue: () => void;
}
```

**Structure:**
```tsx
<div className="flex flex-col">
  {/* Header */}
  <h2 className="mb-6 flex items-center gap-3">
    <Search className="size-5 text-brand" />
    Search
  </h2>

  {/* Search form */}
  <form onSubmit={handleSearch}>
    <Input
      value={query}
      onChange={e => setQuery(e.target.value)}
      placeholder="Search YouTube (e.g. 'never gonna give you up')"
    />
    <button type="submit">Search</button>
  </form>

  {/* Autoplay switch */}
  <Switch checked={autoplay} onChange={setAutoplay} />

  {/* States */}
  {searching && <LoadingState />}
  {results.length > 0 && <ResultsList />}
  {results.length === 0 && !searching && <EmptyState />}
</div>
```

**Result Card Layout:**
```tsx
<div className="result-card">
  <img src={thumbnail} />
  <div className="metadata">
    <h3>{title}</h3>
    <p>{uploader}</p>
    <span>{duration}</span>
  </div>
  <div className="actions">
    <button onClick={() => handlePlay('now')}>Play Now</button>
    <button onClick={() => handlePlay('next')}>Play Next</button>
  </div>
</div>
```

**Play Flow:**
```typescript
async function handlePlay(mode: 'now' | 'next') {
  const result = await cast(videoId, mode);
  if (result) {
    onNavigateToQueue(); // Switch to queue tab
  }
}
```

**States:**

1. **Idle:** Search input visible, no results
2. **Searching:** Skeleton cards (5-10) while loading
3. **Results:** List of result cards with actions
4. **Empty:** "No results for '{query}'" message
5. **Error:** Toast notification (via `useErrorToast`)

**Styling:**
- Reuse StreamController's glass-panel, input, button styles
- Same animations (fade-in, slide-in)
- Same gold gradient for Play Now
- Same outlined style for Play Next
- Mobile-first responsive layout

### Shell Updates

**File:** `web/src/lib/shell.ts`

**Changes:**

1. Add "search" to `AppTab`:
```typescript
export type AppTab = "queue" | "search" | "settings";
```

2. Update `TABS` array:
```typescript
export const TABS: readonly AppTab[] = ["queue", "search", "settings"];
```

3. Add to `TAB_LABEL`:
```typescript
export const TAB_LABEL: Record<AppTab, string> = {
  queue: "Queue",
  search: "Search",
  settings: "Settings",
};
```

4. Add "search" to `Panel`:
```typescript
export type Panel = "speaker" | "lights" | "search" | "queue";
```

5. Update `PANEL_TAB`:
```typescript
export const PANEL_TAB: Record<Panel, AppTab> = {
  speaker: "settings",
  lights: "settings",
  search: "search",
  queue: "queue",
};
```

**Note:** `readTab()` already handles unknown tab values via `RENAMED_TAB` fallback. No changes needed for persisted state migration.

### Tab Bar Updates

**File:** `web/src/components/tab-bar.tsx`

Add Search icon:

```typescript
import { ListMusic, Search, SlidersHorizontal } from "lucide-react";

const TAB_ICON: Record<AppTab, typeof ListMusic> = {
  queue: ListMusic,
  search: Search,
  settings: SlidersHorizontal,
};
```

No other changes - component already renders `TABS` dynamically.

### Page Layout Updates

**File:** `web/src/app/page.tsx`

**Replace StreamController section** in the second Column (right side on desktop):

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

**Auto-focus handling:** Add effect in `SearchPanel` to focus input when tab becomes active:

```typescript
useEffect(() => {
  if (panelVisible("search", tab)) {
    inputRef.current?.focus();
  }
}, [tab]);
```

## User Experience

### Visual Design

**Search Panel:**
- Same glass-panel background as existing panels (`border border-border bg-card`)
- Heading: Search icon (brand color) + "Search" (same style as other panel headings)
- Input: Large, prominent (inherit StreamController's styles)
- Results: Vertical list with clear separation between cards

**Result Cards:**
- Glass-panel styling with hover state
- Thumbnail: 120x67px (16:9 aspect), rounded corners, shadow
- Title: Bold, truncate after 2 lines
- Uploader: Muted text, smaller font
- Duration: Badge style (clock icon + time)
- Buttons: Full-width on mobile, inline on desktop

**Loading State:**
- 5 skeleton cards matching result card layout
- Pulsing animation (same as current AnalyzingCard)

**Empty State:**
- Centered message: "No results for '{query}'"
- Muted text, search icon above message
- Suggestion: "Try a different search term"

**Button Styles:**
- **Play Now:** Gold gradient background (`from-gold to-[#b29124]`), dark text, shadow
- **Play Next:** Outlined (`border border-border bg-white/[0.08]`), white text
- Both: Hover lift effect (`hover:-translate-y-0.5`), disabled state opacity

### Responsive Behavior

#### Mobile (<900px)

**Tab Bar:** Fixed at bottom, three tabs: Queue | Search | Settings

**Search Tab Active:**
- Search panel fills screen (full height minus header and tab bar)
- Results list scrolls within panel
- Player bar visible above tab bar (always)
- Other panels hidden

**After Playing:**
- Auto-switch to Queue tab
- Queue panel appears
- Search panel hidden (but state preserved)

#### Desktop (>900px)

**Layout:** Two-column, all panels visible

**Left Column:**
- Player (now-playing + volume)
- Speaker picker
- Lights panel

**Right Column:**
- Search panel (when search tab active) OR Queue panel (when queue tab active)
- Both panels always mounted, visibility controlled by `panelVisible()`

**Tab Highlighting:** Tab bar hidden on desktop (`min-[901px]:hidden`), but tab state still tracked for panel visibility

### Navigation Flow

**Scenario 1: Search and Play Now**
1. User on Queue tab, looking at their queue
2. Tap Search tab → search panel appears, input auto-focuses
3. Type "rick astley", press Enter
4. 10 results appear
5. Tap "Play Now" on "Never Gonna Give You Up"
6. Track starts playing, queue clears, station starts
7. App auto-switches to Queue tab
8. User sees queue with new track at position 0, now playing

**Scenario 2: Search and Play Next**
1. User on Queue tab, track is playing
2. Tap Search tab
3. Search for "daft punk"
4. Tap "Play Next" on "Get Lucky"
5. Track queues at position 2 (after current track)
6. App auto-switches to Queue tab
7. User sees "Get Lucky" inserted in queue, downloading

**Scenario 3: Browse Results**
1. User searches "lofi beats"
2. Scrolls through 10 results
3. Doesn't like any of them
4. Searches again with "lofi hip hop"
5. New results replace old ones
6. Finds one to play

**Scenario 4: Search Error**
1. User searches while YouTube is rate-limiting
2. Error toast appears: "Sign-in wall detected. Wait it out."
3. Search panel shows previous results (or empty if first search)
4. User can try again later

## Testing Strategy

### Backend Testing

**Manual testing** (no automated tests for endpoints, per project pattern):

**Success cases:**
- Search for popular music: "never gonna give you up"
- Search for artist: "rick astley"
- Search for genre: "lofi beats"
- Search with special characters: "D'Angelo", "AC/DC"
- Search with numbers: "90s hits"
- Verify results have thumbnails, titles, durations

**Edge cases:**
- Empty query (should 400)
- Limit edge cases: 0, 1, 20, 100 (should clamp to 1-20)
- Query with no results (should return empty array)

**Error cases:**
- Stale yt-dlp (simulate with old version)
- Rate limit (trigger with many rapid searches)
- Network failure (disconnect internet)

### Frontend Testing

**Unit Tests:** `web/src/lib/hooks/use-search.test.ts`

```typescript
describe('useSearch', () => {
  test('initializes with empty state');
  test('updates query on setQuery');
  test('sets searching=true during search');
  test('populates results on success');
  test('sets searchError on failure');
  test('clears error on new search');
  test('persists autoplay to localStorage');
  test('sets casting during play');
  test('clears casting after play completes');
  test('sets castError on play failure');
});
```

**Integration Tests:** (in component test or E2E)

```typescript
describe('SearchPanel', () => {
  test('renders search input');
  test('submits search on Enter');
  test('shows loading state while searching');
  test('renders results list on success');
  test('shows empty state when no results');
  test('calls onNavigateToQueue after successful play');
  test('disables play buttons when no device selected');
  test('shows autoplay switch');
});
```

**Manual Testing Checklist:**

- [ ] Search input auto-focuses when switching to Search tab
- [ ] Enter key submits search
- [ ] Search button submits search
- [ ] Loading skeletons appear while searching
- [ ] Results appear after search completes
- [ ] Empty state shows for no results
- [ ] Error toast shows on search failure
- [ ] Play Now button plays track
- [ ] Play Next button queues track
- [ ] App switches to Queue tab after playing
- [ ] Autoplay switch persists across page reloads
- [ ] Mobile: Results scroll within panel
- [ ] Desktop: Search panel appears in right column
- [ ] Disabled state when no speaker selected

## Migration Plan

### Breaking Changes

**Removed:**
- Stream Controller component (URL paste workflow)
- "stream" panel from shell
- All URL analysis logic

**Impact:**
- Users who bookmarked a URL to paste: Must search instead
- Users accustomed to paste workflow: Must learn search workflow

**Mitigation:**
- Search is more discoverable (tab vs buried panel)
- Search is faster (no copy/paste)
- Better mobile experience

### Preserved Functionality

**Unchanged:**
- All playback logic (`/api/play` endpoint)
- Queue management (add, remove, refresh)
- Transport controls (play, pause, skip)
- Station logic (orbit, dedupe, memory)
- Hue integration
- Volume control

**Moved:**
- Autoplay switch: from StreamController to SearchPanel (same behavior)

### Data Migration

**Persisted Tab State:**

`readTab()` already handles unknown tab IDs by falling back to `DEFAULT_TAB` ("queue"). No migration needed.

**Autoplay Setting:**

Uses same localStorage key as StreamController (`yts.autoplay` or similar). Preserved automatically.

## Performance Considerations

### Backend

**Search Endpoint:**
- Uses `extract_flat=True` - no downloads, just metadata fetch
- YouTube search is fast (~1-2 seconds)
- No server-side caching (results change over time)
- Same rate-limit exposure as `/api/info`

**Scaling:**
- Search frequency depends on user behavior (not periodic like SSE polling)
- Expected load: ~1-5 searches per user session
- No memory footprint (no caching)

### Frontend

**Search Panel:**
- Results list: 5-10 items (small, no pagination needed)
- Images: Lazy-loaded thumbnails from YouTube CDN
- No infinite scroll complexity

**State Management:**
- Search state local to component (not global)
- Results cleared when navigating away (no memory leak)
- Autoplay persisted to localStorage only

**Bundle Size:**
- New code: ~300 lines (search panel + hook)
- Removed code: ~400 lines (stream controller + hook)
- Net: Slight reduction

## Security Considerations

**Input Validation:**
- Query sanitization: Let yt-dlp handle escaping (same as `/api/info`)
- Limit clamping: Prevent resource exhaustion (max 20 results)

**Error Exposure:**
- Error messages from yt-dlp already sanitized by existing error handlers
- No stack traces exposed to client

**Rate Limiting:**
- Inherit YouTube's rate limits (via yt-dlp)
- `bot_detected` flag signals when to back off

**CSRF:**
- Not applicable (no auth, GET endpoint is idempotent)

## Future Enhancements

**Out of scope for this design, but possible later:**

1. **Search History:** Remember recent searches (localStorage)
2. **Search Suggestions:** Auto-complete queries
3. **Result Filtering:** By duration, upload date, channel
4. **Pagination:** Load more results on scroll
5. **Preview:** Play 30-second clip before adding to queue
6. **Search from Queue:** Deep link to search with pre-filled query
7. **Voice Search:** Use Web Speech API on supported browsers

## Success Metrics

**User Behavior:**
- Search tab usage vs old StreamController usage
- Searches per session
- Play-from-search success rate (search → results → play)

**Performance:**
- Search response time (should be <2s avg)
- Error rate (should match `/api/info` baseline)

**UX:**
- Users finding Search tab (vs asking "where is URL paste?")
- Mobile vs desktop search usage

## Open Questions

None - design approved for implementation.

## Appendix: API Examples

### Successful Search

**Request:**
```
GET /api/search?q=never+gonna+give+you+up&limit=5
```

**Response:**
```json
{
  "query": "never gonna give you up",
  "results": [
    {
      "id": "dQw4w9WgXcQ",
      "title": "Rick Astley - Never Gonna Give You Up (Official Music Video)",
      "uploader": "Rick Astley",
      "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      "duration": 213
    },
    {
      "id": "ub82Xb1C8os",
      "title": "Never Gonna Give You Up but it's a different link so you can't memorize it",
      "uploader": "Taters",
      "thumbnail": "https://i.ytimg.com/vi/ub82Xb1C8os/hqdefault.jpg",
      "duration": 212
    }
  ]
}
```

### Empty Results

**Request:**
```
GET /api/search?q=sdkfjhskdjfhskdjfh
```

**Response:**
```json
{
  "query": "sdkfjhskdjfhskdjfh",
  "results": []
}
```

### Rate Limited

**Request:**
```
GET /api/search?q=popular+song
```

**Response (429):**
```json
{
  "error": "Sign-in wall detected. YouTube is asking for verification. Wait it out.",
  "bot_detected": true
}
```

### Stale Extractor

**Request:**
```
GET /api/search?q=music
```

**Response (502):**
```json
{
  "error": "Player extraction failed. Update yt-dlp with: make docker-update-ytdlp",
  "stale_extractor": true
}
```
