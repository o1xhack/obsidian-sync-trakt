# 0011 — Daily Notes-only auto sync

- **Status**: implemented
- **Released in**: 1.2.0
- **Date**: 2026-05-17
- **Authors**: @o1xhack, Codex
- **Builds on**: [0001](0001-incremental-sync.md), [0006](0006-daily-notes-integration.md), [0010](0010-local-runtime-cache.md)

## Context

Daily Notes are currently updated only as a side effect of the full sync
pipeline:

1. Fetch Trakt list sources.
2. Refresh detailed watch history.
3. Fetch TMDB / Trakt metadata translations.
4. Reconcile media notes in the vault.
5. Run the Daily Notes catch-up hook.

This is correct but heavier than necessary for users who want their Daily
Note to update often while media notes update less frequently. The common
case is "I watched something on Trakt; update today's Daily Note" rather
than "scan and update 1,000+ media notes every few minutes".

The existing command `Sync to daily notes (today only)` cannot simply be
turned into an auto-sync loop. It renders from `lastMergedItems`, which is
only populated by the most recent sync in the current Obsidian session.
After app restart, device switch, or when the full auto-sync is disabled,
that in-memory snapshot can be empty or stale.

## API / platform research

- Trakt's official API is a REST API for integrating movie and TV
  tracking, including synchronizing watch history, ratings, and lists.
  Primary docs: <https://trakt.docs.apiary.io/> and the official
  TypeScript contract repository: <https://github.com/trakt/trakt-api>.
- This plugin already uses Trakt Sync endpoints with OAuth bearer tokens:
  `/sync/watchlist/{movies|shows}`, `/sync/watched/{movies|shows}`,
  `/sync/favorites/{movies|shows}`, `/sync/ratings/{movies|shows}`, and
  `/sync/history/{movies|episodes}`. History is paginated and supports a
  `start_at` filter in the current client wrapper.
- TMDB details endpoints support `language` and `append_to_response`
  query parameters. We use `/3/movie/{movie_id}` and `/3/tv/{series_id}`
  with `append_to_response=translations` so the translation picker can
  inspect all variants from one request. Official references:
  <https://developer.themoviedb.org/reference/movie-details>,
  <https://developer.themoviedb.org/reference/tv-series-details>,
  <https://developer.themoviedb.org/reference/movie-translations>, and
  <https://developer.themoviedb.org/reference/tv-series-translations>.
- Obsidian recommends `Vault.process()` for modifying a file based on its
  current content because it avoids stale read/modify/write data loss. It
  also recommends `registerInterval()` for plugin timers so intervals are
  cleaned up on unload. Official references:
  <https://docs.obsidian.md/Plugins/Vault> and
  <https://docs.obsidian.md/Plugins/Events>.

## Goals / Non-goals

### Goals

- Add a Daily Notes-only auto-sync option independent from the full
  media-note auto-sync option.
- Allow users to turn off full auto-sync while keeping Daily Notes auto
  updates enabled.
- Keep Daily Notes event coverage consistent with existing settings:
  watched events require detailed watch history, watchlist events require
  the watchlist source, favorites require the favorites source, and
  ratings require the ratings source.
- Reuse the same Trakt/TMDB metadata logic as full sync so Daily Notes
  titles match media-note titles.
- Reuse the same Daily Notes marker safety rules: today follows the
  selected sync mode; past days are add-only.
- Share one sync lock between full sync and Daily-only sync so two timers
  or buttons cannot mutate `historyState`, TMDB cache, or Daily Notes at
  the same time.
- Keep timer settings device-local, matching the existing auto-sync
  behavior.

### Non-goals

- No new Trakt webhook or push system. Obsidian plugins run locally; this
  stays interval-based.
- No new Daily Note files are created. We only update existing Daily Note
  files, as in spec 0006.
- No media note creation, deletion, rename, or frontmatter/body update in
  the Daily-only path.
- No separate server-side cache. Runtime data remains local per spec 0010.
- No per-event template redesign. This feature changes scheduling and
  source refresh, not rendering format.

## Design

### Settings

Add two `TraktrSettings` fields:

```typescript
dailyNotesAutoSyncEnabled: boolean;          // default false
dailyNotesAutoSyncIntervalMinutes: number;   // default 60, UI range 5..360
```

Both keys are `LOCAL_ELIGIBLE_KEYS` and default-local. A Mac can run
Daily-only auto-sync every 15 minutes while iOS keeps it off. The shared
vault settings still control what Daily Notes contain.

### Execution model

Introduce a Daily-only pipeline on `SyncEngine`:

```typescript
syncDailyNotesData(onProgress?: SyncProgress): Promise<DailyNotesDataSyncResult>
```

It does:

1. Ensure the Trakt token is valid.
2. Build the same in-memory merged item map used by full sync from the
   enabled source endpoints.
3. If watched detail is enabled, refresh detailed history using the same
   incremental/full-refresh logic as full sync.
4. Apply `historyState` to the merged items.
5. Enrich metadata with the same TMDB / Trakt translation path as full
   sync.
6. Persist mutated runtime state with `saveSettings()`.
7. Return the merged items to the plugin.

It does not call:

- `ensureTagNotes()`
- `scanExistingNotes()`
- `reconcileType()`
- note rename, delete, or frontmatter merge logic

The plugin then runs one of the existing Daily Notes writers:

- auto Daily-only sync: `processCatchUp()` so missed days are filled.
- manual "today only" command: `processDate(today, "today")`.

### Shared locking

Full sync and Daily-only sync use the same `SyncEngine.syncing` lock.
If a run is already active, the second run is skipped with a user notice.

This means the system never has two concurrent writers to:

- `settings.historyState`
- `settings.tmdbCache`
- `lastMergedItems`
- Daily Note marker regions
- media note files

### Timer behavior

The plugin owns two interval ids:

```typescript
autoSyncIntervalId: number | null
dailyNotesAutoSyncIntervalId: number | null
```

Full auto-sync uses the existing `autoSyncEnabled` setting. Daily-only
auto-sync uses the new Daily Notes settings and only starts when:

- the user is connected to Trakt,
- Daily Notes integration is enabled,
- Daily Notes auto-sync is enabled.

Full sync still runs the Daily Notes hook at the end. If both timers are
enabled and fire near each other, the shared lock serializes/blocks one
run. The Daily-only timer does not try to "catch up" immediately after a
skipped interval; the next interval is enough because Trakt history is
stateful and incremental.

Timers are reconfigured whenever relevant settings change, after Trakt
auth succeeds, after disconnect, and after the plugin re-reads `data.json`
on `visibilitychange`. This matters for multi-device vaults: if a token
arrives from another device through Obsidian Sync, the local device can
start its own enabled timers without waiting for a plugin reload.

## Scenario matrix

| Scenario | Expected behavior |
|---|---|
| Full auto-sync off, Daily auto-sync off | Nothing runs automatically. Manual commands still work. |
| Full auto-sync on, Daily auto-sync off | Current behavior: full sync runs and updates Daily Notes at the end. |
| Full auto-sync off, Daily auto-sync on | Daily-only sync refreshes source data and writes Daily Notes; media notes are untouched. |
| Both auto-sync timers on, different intervals | Each timer runs its own path. Shared lock prevents overlap. |
| Both timers fire at the same time | First run wins. Second run sees the lock and skips with an "already syncing" notice. |
| User clicks full Sync while Daily-only auto-sync is running | Full sync is skipped by the same lock; no concurrent writes. |
| User clicks Daily Notes command while full sync is running | Daily command is skipped by the same lock; full sync will update Daily Notes at the end. |
| User disables Daily Notes integration while Daily auto-sync is on | Daily auto interval is cleared; settings keep the previous Daily auto value for later re-enable. |
| User disconnects Trakt | Both auto-sync paths do nothing because access token is absent. |
| `syncWatchedDetail` off | Watched lines do not appear, matching existing Daily Notes source gating. |
| `syncMovies` off | Movie watched events are not fetched or rendered. |
| `syncShows` off | Episode watched events are not fetched or rendered. |
| TMDB key absent | Daily-only sync uses Trakt translation fallback exactly like full sync. |
| TMDB cache cold or invalidated | Daily-only sync may fetch metadata and write local runtime cache, but still does not write media notes. |
| Daily Note file missing | Date is skipped; no file is created. |
| Today mode = default | Today marker region is replaced from the current snapshot. |
| Today mode = incremental | New event lines are appended; user edits inside markers are preserved. |
| Past day has non-empty markers | Past day is skipped, preserving existing content. |
| Past day has empty markers | Past day is filled in place. |
| Past day has no markers | Marker block is appended to the existing file. |

## Alternatives considered

### Render from `lastMergedItems` only

Rejected. It fails after Obsidian restart and when full auto-sync is off.
It can also render empty Daily Notes if the in-memory snapshot has not
been populated in the current session.

### Fetch only `/sync/history` for Daily-only sync

Rejected for 1.2.0. It is faster, but detailed history alone does not
cover watchlist, favorites, or ratings events. It also does not provide a
complete enough metadata snapshot for every existing history entry after
restart. We can revisit a narrower history-only fast path later if users
need even lower API usage.

### Let full and Daily-only timers run independently

Rejected. Concurrent runs can race on `historyState`, runtime cache, and
the same Daily Note file. A shared lock is simpler and safer.

## Migration / backward compatibility

Existing users get:

- `dailyNotesAutoSyncEnabled = false`
- `dailyNotesAutoSyncIntervalMinutes = 60`

No existing automatic behavior changes. Full sync still updates Daily
Notes when Daily Notes are enabled. Users opt in to the separate Daily
auto-sync explicitly.

Because the new timer settings are default-local, enabling Daily auto-sync
on one device does not force every synced device to run its own Daily
timer.

## Tests

Smoke tests must cover:

- New settings defaults.
- New local-eligible/default-local keys.
- Daily-only sync uses the same cache freshness and metadata path as full
  sync after metadata refactor.
- Daily-only sync lock returns "already syncing" when a run is active.
- Daily command / auto-sync wiring does not render from stale
  `lastMergedItems` without first refreshing source data.
- Existing Daily Notes pure functions remain unchanged.

Manual QA before 1.2.0 draft release:

- Full sync button still writes media notes and then Daily Notes.
- Daily Notes command refreshes today's Daily Note after app restart.
- Full auto-sync off + Daily auto-sync on updates Daily Notes only.
- Both timers enabled do not produce duplicate marker writes.
- iOS/mobile path shows progress notices because status bar is absent.

## Future work

- A history-only ultra-light mode that renders only watched events.
- A "run Daily-only sync now" button inside the Daily Notes settings tab.
- Last-run timestamps for both timers in settings.
- Better progress copy that distinguishes "fetching data for Daily Notes"
  from a full media-note sync.
