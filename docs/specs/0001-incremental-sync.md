# 0001 — Incremental sync (TMDB cache + Trakt history state)

- **Status**: implemented
- **Released in**: 0.2.0
- **Date**: 2026-05-10
- **Authors**: @o1xhack, Claude
- **Supersedes**: —

## Context

By 0.1.x the plugin's per-sync API cost looked like this for a user with
~1200 catalog items and detailed watch history enabled:

| Source | Calls | Notes |
|---|---:|---|
| Trakt list endpoints (watchlist / watched / favorites / ratings, movies + shows) | ~30 | Paginated, fast |
| Trakt `/sync/history/episodes` | ~150 | Paginated 100 events/page over a multi-thousand-event history |
| Trakt `/sync/history/movies` | ~7 | Paginated 100 events/page |
| TMDB `/movie/{id}` or `/tv/{id}` | ~1200 | One per item, every sync |
| **Total** | **~1390** | **3-5 minutes wall time** |

Two real problems flowed from this:

1. **Wall-time pain.** Sync was visibly slow on every run, even after the
   first one. Most users wouldn't notice — they'd run sync once a week —
   but a power user iterating on settings (e.g. changing
   `metadataLanguage` to test localization) experiences each iteration as
   a 3-5 minute wait.

2. **Hidden 429s.** TMDB's documented rate limit is 50 req/s. A
   `Promise.all` burst of 1200 simultaneous requests far exceeded that.
   Errors were silently swallowed — `fetchTmdbMetadata` returned
   `{ poster_url: "", translation: null }` on any non-200, with only a
   `console.warn` to indicate failure. Users observed missing posters
   and missing translations and assumed a bug elsewhere. (0.1.3 partially
   addressed this with `processWithConcurrency(5)`, capping in-flight
   requests, but the underlying full-refresh-every-time waste remained.)

The architectural fix is simple in framing: **cache what doesn't change,
incrementally fetch what does**. Movie / TV metadata on TMDB rarely
changes once a title is released. New watch events on Trakt are append-
mostly — users add events far more often than they delete.

## Goals / Non-goals

### Goals

- A second sync, with no library changes, should issue **fewer than 30
  total API calls** and complete in **single-digit seconds**
- New watch events should appear in the note body within one sync of
  watching them, with **at most one Trakt history page** fetched on the
  fast path
- A periodic full refresh of Trakt history exists to catch event
  **deletions**, since incremental fetch can't see them
- TMDB cache should be transparently fault-tolerant: a stale entry that
  failed to revalidate doesn't break sync; a rate-limited revalidation
  doesn't lose old data
- All cache state survives device-to-device sync — a user with Mac +
  iPhone shouldn't pay the cold-start cost twice

### Non-goals

- **Real-time deletion detection.** We accept up to N days of lag (where
  N is the configurable full-refresh interval, default 7) in exchange
  for simplicity
- **Cross-language TMDB cache reuse.** Each `(type, tmdbId, language)`
  triple has its own cache entry. Users who switch metadata language
  pay a fresh fetch for the new language — once
- **Trakt list incremental.** Watchlist / favorites / ratings are short
  lists where full fetch is cheap (~10-30 calls total). Adding an
  incremental layer there would be more complexity than savings
- **Image caching to vault disk.** TMDB poster URLs are rendered as
  external `https://image.tmdb.org/...` links. Downloading and storing
  images locally is a separate question (Bases compatibility, vault
  size) deferred to a future spec
- **Server-side cache.** All state lives in `data.json`, follows the
  user's vault sync layer. Zero plugin-managed cloud infrastructure

## Design

The design splits cleanly into two independent caches with one small
shared concern (settings auto-reload).

### Part A — TMDB metadata cache

#### Storage

A single keyed map in `TraktrSettings.tmdbCache`. Every existing settings
field is preserved; new field defaults to `{}`.

```typescript
type TmdbCacheKey = string;     // `${type}:${tmdbId}:${language || 'default'}`

interface TmdbCacheEntry {
  poster_url: string;           // possibly "" if TMDB had no poster
  translation: TmdbTranslation | null;
  cached_at: number;            // unix ms when the entry was written
  expires_at: number;           // unix ms when entry should be refreshed
}

interface TmdbCache {
  [key: TmdbCacheKey]: TmdbCacheEntry;
}
```

The key includes `type` so a movie and a TV show with the same TMDB id
don't collide. It includes `language` so each Chinese variant (and each
non-Chinese language) gets its own slot — switching from `zh-CN` to
`ja-JP` is a clean cache miss for ja-JP entries, not a mistaken cache
hit returning Chinese.

#### TTL with jitter

A shared TTL across all 1200 entries would mean all entries expire on
the same day → a single dramatically slow sync every N days. To prevent
that, the TTL stored per-entry is the configured TTL **plus a random
jitter of ±5 days** (clamped to ≥ 1 day):

```typescript
const ttlMs = settings.tmdbCacheTtlDays * 86400_000;
const jitterMs = (Math.random() - 0.5) * 10 * 86400_000;  // ±5 days
const expires_at = Date.now() + Math.max(86400_000, ttlMs + jitterMs);
```

For `tmdbCacheTtlDays = 90`, this means individual entries expire in a
85–95 day window, so the steady-state daily revalidation rate is roughly
`size / 90` items.

#### Lazy revalidation (stale-while-revalidate)

A naive cache check looks like:

```
if entry exists AND entry.expires_at > now → use cached
else → fetch fresh, write to cache, use fresh
```

The problem is that fetch can fail (network blip, TMDB 429). On failure
we'd lose the cached entry. Fix: stale entries are **served immediately**
and re-fetched in the background; failed background fetches don't delete
the existing cache.

```
Look up entry.
  ├─ no entry → fetch synchronously, write, return.
  ├─ entry fresh (expires_at > now) → return cached.
  └─ entry stale → return cached immediately, AND fire-and-forget a
                    background fetch that writes a new entry on success
                    (silently keeps the old entry on failure).
```

The synchronous path of a sync is therefore bounded by the number of
**genuinely missing** entries (new items added to library since last
sync), not by TTL expirations. A user's first sync after a 90-day gap
still completes quickly — it returns last-known data and refreshes in
the background over the next few syncs.

#### Cache size / data.json bloat

For ~1200 items × 2-3 languages tried = ~3000 entries, ~500 bytes each
JSON-serialized = ~1.5 MB cache. Obsidian's `loadData()` /
`saveData()` handle this without UX issue (instant on disk, sub-100ms
parse).

The user can observe size + manually clear via Settings:

```
TMDB cache:  3,127 entries (~1.5 MB)
[Clear cache]    ← drops everything; next sync fully repopulates
```

### Part B — Trakt history state

History is the second cost center and the user's primary interest
(detailed per-episode watch records).

#### Storage

```typescript
interface EpisodeWatchHistory {
  season: number;
  episode: number;
  title?: string;
  watched_at: string[];         // ISO-8601, chronologically sorted
}

interface HistoryState {
  // Aggregated, ready to render. Indexed by trakt id.
  byMovie: { [traktMovieId: number]: string[] };           // timestamps
  byShow: { [traktShowId: number]: EpisodeWatchHistory[] };

  // Set of every event id we've seen. Used during full refresh to
  // detect deletions: events present here but absent from the new
  // full-history fetch were deleted on Trakt's side.
  knownEventIds: number[];

  // ISO-8601 timestamp of the latest event we've ingested. Next sync
  // queries `/sync/history?start_at=lastIncrementalSyncAt`.
  lastIncrementalSyncAt: string;

  // ISO-8601 timestamp of the last full re-pull. After
  // `historyFullRefreshIntervalDays` we re-pull the entire history
  // (within the configured window) to catch deletions.
  lastFullRefreshAt: string;
}
```

`HistoryState` is a single object stored at `TraktrSettings.historyState`.

#### Fast path: incremental fetch

```
const t = getEffectiveSettings(...);
const startAt = state.lastIncrementalSyncAt;

// One paginated call; for typical week-long gaps this is one page.
const events = await fetchHistory({type, startAt, clientId, accessToken});
mergeNewEvents(state, events);
state.lastIncrementalSyncAt = events.length > 0
  ? events[events.length - 1].watched_at
  : new Date().toISOString();
```

`mergeNewEvents` walks the event list and, for each event whose `id` is
not already in `knownEventIds`:

- **Episode event**: append `watched_at` to `byShow[showId]`'s entry
  for `(season, episode)`. Create the entry if it doesn't exist. Push
  `id` into `knownEventIds`.
- **Movie event**: append `watched_at` to `byMovie[movieId]`. Push id.

For an event whose id is already in `knownEventIds`, do nothing. This
makes incremental sync **idempotent** — replaying the same events
list twice yields the same state.

After merge, sort each `watched_at` array chronologically, sort each
show's `episodes` array by season then episode.

#### Slow path: full refresh (deletion detection)

Triggered when `now - lastFullRefreshAt > historyFullRefreshIntervalDays`.

```
const allEvents = await fetchHistory({type, clientId, accessToken});  // no start_at

const newEventIds = new Set(allEvents.map(e => e.id));
const deletedIds = state.knownEventIds.filter(id => !newEventIds.has(id));

if (deletedIds.length === 0) {
  // No deletions detected — keep state as-is, just bump lastFullRefreshAt.
  state.lastFullRefreshAt = new Date().toISOString();
} else {
  // Rebuild state from scratch from the canonical full event list.
  state = stateFromEvents(allEvents);
  state.lastFullRefreshAt = new Date().toISOString();
}
```

`stateFromEvents` is a pure function: take a list of events, group by
movie/show, sort timestamps, return a fresh `HistoryState`.

The delete-detection path is intentionally simple: we don't try to
surgically patch the existing state, we just rebuild it. The cost is
running `stateFromEvents` on N events (N up to ~15K for active users) —
all in-memory, sub-100ms.

#### Force-refresh command

A new command, **Traktr: Force full history refresh**, immediately
triggers the slow path regardless of `lastFullRefreshAt`. Useful when
the user knows they just deleted a wrong scrobble on Trakt and wants the
plugin to reflect it now.

#### When syncWatchedDetail is off

`HistoryState` is left untouched — neither read nor written. If the user
later turns it on, the next sync triggers a full refresh (no
`lastIncrementalSyncAt`, so we pull the full history once and seed the
state).

### Part C — Settings auto-reload

When the same vault is used on Mac and iPhone via Obsidian Sync,
`data.json` arrives on iPhone after the user runs sync on Mac. But the
iPhone plugin's in-memory `this.settings` only gets read at `onload()`,
so until the user disables and re-enables the plugin, sync state from
Mac is invisible.

Fix: subscribe to `document` `visibilitychange` events and re-read
`data.json` when the app becomes visible again (e.g. user switches back
to Obsidian from another app).

```typescript
this.registerDomEvent(document, "visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void this.refreshSettingsFromDisk();
  }
});

private async refreshSettingsFromDisk() {
  const fresh = (await this.loadData()) as Partial<TraktrSettings> | null;
  // Mutate this.settings IN PLACE so SyncEngine's reference stays valid.
  // Object.assign with Object.keys clears removed fields, then merges fresh.
  for (const k of Object.keys(this.settings)) delete this.settings[k];
  Object.assign(this.settings, DEFAULT_SETTINGS, fresh);
}
```

In-place mutation matters: `SyncEngine` was constructed with a reference
to the original `this.settings` object. Replacing the object would leave
the engine pointing at stale data. Mutating preserves the reference.

### Wire-up: full sync flow with caching enabled

```
sync(onProgress):
  ensureValidToken()
  fetchAndMergeMovies(merged):
    Promise.all([
      syncWatchlist?    fetchWatchlist("movies")
      syncWatched?      fetchWatchedMovies()
      syncFavorites?    fetchFavorites("movies")
      syncRatings?      fetchRatings("movies")
      syncWatchedDetail? fetchHistoryIncremental("movies", state.lastIncrementalSyncAt)
                          OR fetchHistory("movies")  if full-refresh due
    ])
    populate merged from list endpoints
    mergeNewEvents(state, history) | replaceFromFullRefresh(state, history)
  fetchAndMergeShows(merged):  // same shape
  ensureTagNotes(merged)
  reconcileType(merged):
    scanExistingNotes()
    for each item with tmdb id:
      cache lookup by (type, tmdbId, language)
      cache hit (fresh) → use cached
      cache hit (stale) → use cached, async revalidate
      cache miss        → fetch sync, write cache
      apply translation, set poster_url
    apply HistoryState to items (sets item.watch_history_movie / _episodes)
    create or update each note
```

The cache lookup is part of `fetchTmdbMetadata` — callers don't see the
difference. Stale-while-revalidate happens transparently inside that
function.

## Alternatives considered

### Server-side cache (rejected)

Hosting a small backend that caches TMDB responses across all plugin
users, returning shared data via a thin API. **Rejected** because:

- Operational burden (uptime, costs, abuse mitigation)
- Privacy story (server sees library contents)
- Conflict with the plugin's "everything stays in your vault"
  positioning — the README, SETUP, MANUAL all promise no server

### Per-event diff against vault frontmatter (rejected for history)

Read each show's existing note frontmatter to reconstruct what we've
already seen, then compare against new history events. **Rejected** because:

- Coupling history state to vault contents creates ordering issues
  (delete a note, lose history; rename a note, fragile lookup)
- Markdown is not a great database — frontmatter doesn't hold per-event
  ids, only aggregated lists
- A dedicated state object in `data.json` is faster, cleaner, and works
  identically whether or not notes have been edited

### Periodic full TMDB refresh (rejected)

A sibling to history's full refresh: every N days, re-fetch every
TMDB entry to catch upstream metadata changes (new translations etc.).
**Rejected** because:

- TMDB's translation moderation is slow; a 90-day TTL captures most
  changes
- A scheduled full TMDB refresh recreates exactly the wall-time pain
  this spec is meant to fix
- Manual "Clear TMDB cache" gives users full control when they want it

### Bigger TTL window (e.g. 1 year) (deferred)

Considered making the default TTL 365 days instead of 90, on the theory
that movies almost never change. Kept at 90 because:

- Chinese / Japanese translation edits are reasonably common on TMDB
  (community-moderated, ongoing)
- 90 days × 1200 items / 90 = ~13 revalidations/day in steady state —
  invisible
- Setting allows 365 if user wants it

## Migration / backward compatibility

Users on 0.1.x have:

- `tmdbCache` field absent from data.json → defaults to `{}`
- `tmdbCacheTtlDays` field absent → defaults to `90`
- `historyState` field absent → defaults to `{ byMovie: {}, byShow: {},
  knownEventIds: [], lastIncrementalSyncAt: "", lastFullRefreshAt: "" }`
- `historyFullRefreshIntervalDays` field absent → defaults to `7`

On the first 0.2.0 sync:

1. TMDB cache is empty → every TMDB call is a cache miss → 1200 fetches
   (same as 0.1.x). After this, populated.
2. `lastIncrementalSyncAt` is empty string → triggers a "full pull" on
   the first run anyway. State is seeded from the full event list as if
   that were the initial full refresh.
3. `lastFullRefreshAt` is empty string → next-eligible full refresh
   computed as "more than 0 ms ago" → always-eligible. Standard sync
   schedule kicks in from there.

So **the first 0.2.0 sync looks like a 0.1.x sync** in cost. The second
sync onwards is fast.

Existing notes are not modified by the upgrade. The watch-history
markers added in 0.1.1 still work; `updateManagedBodySections` continues
to update them in place from the new `HistoryState`-driven data.

## Tests

A tests/i18n.smoke.ts case is added per behavior:

**TMDB cache:**

- Cache miss writes a fresh entry with `cached_at` and `expires_at`
- Cache hit (fresh) returns cached value without calling `requestUrl`
- Cache hit (stale) returns cached value AND triggers async refresh
- Cache TTL jitter: 100 entries written sequentially have `expires_at`
  spread across ≥ 7 days
- `clearTmdbCache()` empties the entry map
- Cache key disambiguates `(movie, 155, zh-CN)` from `(movie, 155, ja-JP)`
- Cache key disambiguates `(movie, 155)` from `(show, 155)`

**History state — incremental merge:**

- New event for known show → appended to existing episode entry
- New event for unknown show → entry created
- Re-watch (same season/ep, new event id) → second timestamp added
- Replaying same events twice is idempotent (no duplicate timestamps)
- Movie watch events parallel to show events: separate maps untouched

**History state — full refresh:**

- All events present in full pull → state unchanged (just bump
  `lastFullRefreshAt`)
- Some `knownEventIds` missing from full pull → rebuild state, deleted
  events absent from `byShow` / `byMovie`
- Force refresh command bypasses interval check

**Settings auto-reload:**

- `refreshSettingsFromDisk` mutates `this.settings` in place (object
  identity preserved)
- Removed fields are cleared, not retained from old state

## Future work

- **Force-refresh of a single note**: right-click → "Refresh metadata"
  for a single note. Useful when the user knows TMDB updated one
  specific entry. Out of scope here; needs UI thinking
- **TMDB cache import / export**: would let a heavy user pre-populate
  cache on a faster machine and copy to a slower one. Niche
- **Trakt list incremental via `last_activities`**: skip refetching
  watchlist when activity timestamp hasn't changed. Saves ~10-30
  Trakt calls per sync. Modest gain, low priority
- **Compress `historyState` storage**: currently full ISO strings;
  could store as deltas or compact integers. Not pressing — current
  size is well under data.json's reasonable limits
