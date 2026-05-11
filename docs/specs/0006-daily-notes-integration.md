# 0006 — Daily Notes integration

- **Status**: draft (awaiting user approval)
- **Targeted**: 0.7.0
- **Date**: 2026-05-11
- **Authors**: @o1xhack, Claude
- **Builds on**: [0001-incremental-sync](0001-incremental-sync.md),
  [0002-diff-based-write](0002-diff-based-write.md),
  [0005-settings-ui-tabs](0005-settings-ui-tabs.md)

## Context

Users who enable detailed watch history (spec 0002) accumulate a rich
stream of timestamped events: per-episode watches, watchlist additions,
favorite toggles, rating changes. Currently these are surfaced per-item
(the watch-history block in show notes; the `trakt_*_at` frontmatter
fields). There's no **per-day** view of "what did I do on
2026-05-12".

Inspiration: the [obsidian-weread-plugin](https://github.com/zhaohongxuan/obsidian-weread-plugin)
implements the same pattern for reading highlights — inject today's
events into the user's Daily Note inside a configurable marker-bounded
region. We adopt the same UX, generalized to all our event types.

This is a non-trivial feature because we're modifying **user-owned files**
(Daily Notes), not files we created. The safety contract — never
corrupt a user's note outside our markers — is the spec's most important
section.

## Goals / Non-goals

### Goals

- Auto-inject per-event lines into the user's Daily Note for today,
  on every sync run (whether manual, auto-sync, command palette, or
  startup)
- Smart catch-up: if user was away N days, fill those days too, with
  add-only safety
- Cover all event types whose **source sync is enabled**:
  - Watched (requires `syncWatchedDetail`)
  - Added to watchlist (requires `syncWatchlist`)
  - Favorited (requires `syncFavorites`)
  - Rated (requires `syncRatings`)
- One-time manual backfill button for first-install users (default
  N=7, configurable 1-30 days)
- Multi-language: entries rendered in `metadataLanguage`; UI labels
  in `uiLanguage`
- Live preview in settings showing a 3-line example
- Never modify a Daily Note outside our marker region — **this is a
  hard data-integrity constraint**

### Non-goals

- **Creating Daily Notes that don't exist** — we never `vault.create`
  a Daily Note. Skip dates where the file is absent. This makes us
  Daily-Notes-plugin-agnostic and gives the user full control over
  which days have entries
- **Modifying notes that lack our markers on past days** — past = add
  markers only if none present; if user has hand-edited Daily Notes
  with their own structure, we don't impose ours
- **Cross-device coordination** of `lastDailyNoteSyncedAt`. Each device
  tracks its own cursor. Multiple devices syncing the same day are
  idempotent for "today" (overwrite same content) and safe for past
  (skip if markers present, regardless of who added them)
- **Integration with the Obsidian Daily Notes plugin** as a dependency.
  We read the user's configured folder + filename format ourselves
- **Per-event-type templates** in v1. Single line template with
  `{{time}} {{action}} {{display}}` placeholders covers everything
- **Backfill that overwrites past markers** — backfill is add-only on
  past days too. Power users wanting to refresh a specific past day
  can manually delete the markers and let the next sync re-add
- **Search-and-replace of Daily Notes structure** if user changes
  marker strings mid-flight. Old notes keep their old markers; new
  inserts use the new markers. No migration

## Design

### Data model

New `TraktrSettings` fields:

```typescript
interface TraktrSettings {
  // ... existing fields ...

  dailyNotesEnabled: boolean;
  dailyNotesFolder: string;              // e.g. "Daily" or "01 Daily"
  dailyNotesFilenameFormat: string;      // Moment.js format, e.g. "YYYY-MM-DD" or "YYYY/YYYY.MM.DD"
  dailyNotesMarkerStart: string;
  dailyNotesMarkerEnd: string;
  dailyNotesEntryTemplate: string;       // line template
  dailyNotesBackfillDays: number;        // 1..30
}
```

New `HistoryState` field:

```typescript
interface HistoryState {
  // ... existing
  lastDailyNoteSyncedAt: string;         // "YYYY-MM-DD" (empty on first run)
}
```

`lastDailyNoteSyncedAt` lives inside `historyState` (already in
data.json) — adjacent to `lastIncrementalSyncAt` so the two history-
related cursors are co-located.

### Defaults

```typescript
dailyNotesEnabled:          false
dailyNotesFolder:           "Daily"
dailyNotesFilenameFormat:   "YYYY-MM-DD"
dailyNotesMarkerStart:      "%% trakt:daily:start %%"
dailyNotesMarkerEnd:        "%% trakt:daily:end %%"
dailyNotesEntryTemplate:    "{{time}} — {{action}} {{display}}"
dailyNotesBackfillDays:     7
```

Default markers are **invisible Obsidian comments** (consistent with
our existing watch-history-block convention in show notes). User can
customize to visible markdown — e.g. `## 今日 Trakt` and
`<!-- end trakt -->` — if they prefer the section to show up in
reading view.

### Marker block layout

After successful insert, a Daily Note contains:

```markdown
... user's existing content ...

%% trakt:daily:start %%
<!-- Auto-generated by Sync Trakt. Do not edit between these markers — your changes will be overwritten on next sync. -->

10:00 — 看了 低智商犯罪 (2026) S1E16, S1E17
14:30 — 加入想看 重生 (2020)
21:30 — 看了 黑暗骑士 (2008)

%% trakt:daily:end %%
```

The HTML-comment warning line is **injected on every write** in the
user's `uiLanguage`. Even if the user deletes it, next sync re-adds.

### Event aggregation (per date, local timezone)

For a given local date `D`:

1. **Watched events** (only if `syncWatchedDetail` is on):
   - For each `watched_at` in `historyState.byMovie[id]` where
     `localDateOf(watched_at) === D` → one event of type `watched`
   - For each show in `historyState.byShow[id]`, for each
     `EpisodeWatchHistory.watched_at` where `localDateOf(...) === D`
     → one event of type `watched` with episode metadata
2. **Watchlist additions** (only if `syncWatchlist` is on):
   - For each merged item with `watchlist_added_at` where
     `localDateOf(watchlist_added_at) === D` → one event of type
     `added_to_watchlist`
3. **Favorites** (only if `syncFavorites` is on):
   - Same pattern with `favorited_at` → event type `favorited`
4. **Ratings** (only if `syncRatings` is on):
   - Same pattern with `rated_at` → event type `rated` (includes the
     rating value)

All events get a unified shape:

```typescript
interface DailyNoteEvent {
  timestamp: string;        // ISO; preserved verbatim for sort stability
  localTime: string;        // "HH:MM" computed once
  action: EventAction;      // "watched" | "added_to_watchlist" | "favorited" | "rated"
  item: NormalizedItem;
  // Only for watched-show events:
  season?: number;
  episode?: number;
  // Only for rated events:
  ratingValue?: number;
}
```

Sort ascending by `timestamp`.

#### Same-timestamp merge rule

If two `watched` events have:
- Same item (same `traktId`)
- Same `timestamp` exactly (string equality)

Then merge into a single line with comma-separated episodes:
`"S1E16, S1E17"`. This handles the Trakt batch-scrobble case.

Different-timestamp events stay as separate lines, even if very close
in time. Reason: the user explicitly said "two episodes = two
timestamps = two lines" except for the rare exact-tie case.

### Entry rendering

Template uses three placeholders:

| Placeholder | Resolves to |
|---|---|
| `{{time}}` | Local "HH:MM" (24-hour) |
| `{{action}}` | Localized verb per metadataLanguage |
| `{{display}}` | Subject text — see below |

#### Localized verbs

| Action | en | zh-CN | zh-TW |
|---|---|---|---|
| watched | watched | 看了 | 看了 |
| added_to_watchlist | added to watchlist | 加入想看 | 加入想看 |
| favorited | favorited | 收藏了 | 收藏了 |
| rated | rated `{N}`/10 | 打分 `{N}`/10 | 打分 `{N}`/10 |

Locales without explicit translations fall back to English (same as
note templates).

#### Display rendering

- **Movie**: `{title} ({year})`
  - e.g. `黑暗骑士 (2008)` (zh-CN) or `The Dark Knight (2008)` (en)
- **Show, single episode**: `{title} ({year}) S{season}E{episode}`
  - e.g. `低智商犯罪 (2026) S1E16`
- **Show, merged episodes (same-timestamp)**:
  `{title} ({year}) S{season}E{ep1}, S{season}E{ep2}, …`
  - e.g. `低智商犯罪 (2026) S1E16, S1E17`

`{title}` and `{year}` come from the `NormalizedItem` in the user's
`metadataLanguage`, matching the show/movie notes elsewhere in the
plugin. **No 书名号 / quotation marks.**

#### Final per-line output

`{{time}} — {{action}} {{display}}` expands to:

```
21:30 — 看了 低智商犯罪 (2026) S1E16, S1E17
14:30 — 加入想看 重生 (2020)
22:00 — 打分 9/10 黑暗骑士 (2008)
```

### Catch-up algorithm (runs at end of every sync)

```typescript
async function processCatchUp(): Promise<void> {
  if (!settings.dailyNotesEnabled) return;

  const today = localTodayISODate();  // e.g. "2026-05-11"
  const last = historyState.lastDailyNoteSyncedAt;

  // First-ever run: don't backfill historically — that's the
  // explicit "Backfill" button's job. Just process today.
  if (!last) {
    await processDate(today, { mode: "today" });
    historyState.lastDailyNoteSyncedAt = today;
    return;
  }

  // Subsequent runs: walk from (last + 1 day) through today inclusive.
  // Past days are add-only; today is always overwritten.
  let cursor = addDays(last, 1);
  const SAFETY_CAP = 90;  // see edge case 12
  if (daysBetween(cursor, today) > SAFETY_CAP) {
    console.warn(`[Traktr] Daily catch-up gap >${SAFETY_CAP} days; clipping`);
    cursor = subtractDays(today, SAFETY_CAP);
  }

  while (cursor <= today) {
    const mode = (cursor === today) ? "today" : "past";
    await processDate(cursor, { mode });
    historyState.lastDailyNoteSyncedAt = cursor;
    cursor = addDays(cursor, 1);
  }
}

async function processDate(date: string, { mode }): Promise<void> {
  const path = computeDailyNotePath(date);
  const file = vault.getAbstractFileByPath(path);
  if (!file) return;  // File missing: skip silently

  const content = await vault.read(file);
  const hasMarkers = isMarkerRegionValid(content);
  const events = aggregateEvents(date);

  if (mode === "past") {
    if (hasMarkers) return;  // SAFETY: don't touch existing markers on past days
    if (events.length === 0) return;  // nothing to add
    const block = renderBlock(events);
    await vault.process(file, (old) => appendBlock(old, block));
  } else {
    // mode === "today"
    if (events.length === 0 && !hasMarkers) return;  // don't create empty block
    if (hasMarkers) {
      await vault.process(file, (old) => replaceMarkerBlock(old, events));
    } else {
      const block = renderBlock(events);
      await vault.process(file, (old) => appendBlock(old, block));
    }
  }
}
```

Important: `lastDailyNoteSyncedAt` advances **only after** a date's
`processDate` returns. If a date throws, the cursor stays at the prior
day; next sync retries from there. This makes catch-up idempotent
under transient errors.

### Marker handling

```typescript
function isMarkerRegionValid(content: string): boolean {
  const startIdx = content.indexOf(settings.dailyNotesMarkerStart);
  const endIdx = content.indexOf(settings.dailyNotesMarkerEnd);
  return startIdx !== -1 && endIdx !== -1 && endIdx > startIdx;
}

function replaceMarkerBlock(content: string, events: DailyNoteEvent[]): string {
  const startIdx = content.indexOf(settings.dailyNotesMarkerStart);
  const endIdx = content.indexOf(settings.dailyNotesMarkerEnd, startIdx);
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + settings.dailyNotesMarkerEnd.length);
  return before + renderBlock(events) + after;
}

function appendBlock(content: string, block: string): string {
  const trimmed = content.replace(/\s+$/, "");
  return `${trimmed}\n\n${block}\n`;
}

function renderBlock(events: DailyNoteEvent[]): string {
  const warning = t("daily.warningComment", uiLanguage);
  const lines = events.map(renderEntry).join("\n");
  return `${settings.dailyNotesMarkerStart}\n<!-- ${warning} -->\n\n${lines}\n\n${settings.dailyNotesMarkerEnd}`;
}
```

Warning text (in en):
> "Auto-generated by Sync Trakt. Do not edit between these markers — your changes will be overwritten on next sync."

Same in zh-CN:
> "由 Sync Trakt 自动生成。请勿编辑两个标记之间的内容 —— 下次同步时会被覆盖。"

### One-time backfill (manual button + command)

Settings → Daily Notes tab → button: **"Backfill last {N} days"** (N is
slider 1-30, default 7). Same algorithm as catch-up, but starts from
`today - N + 1` and ignores `lastDailyNoteSyncedAt`:

```typescript
async function manualBackfill(days: number): Promise<void> {
  const today = localTodayISODate();
  const startDate = subtractDays(today, days - 1);
  let cursor = startDate;
  let touched = 0, skipped = 0;

  while (cursor <= today) {
    const mode = (cursor === today) ? "today" : "past";
    const before = await fileExistsAndHasContent(cursor);
    await processDate(cursor, { mode });
    const after = await fileExistsAndHasContent(cursor);
    if (after && !before) touched++;
    else if (!after) skipped++;
    cursor = addDays(cursor, 1);
  }

  historyState.lastDailyNoteSyncedAt = today;
  new Notice(t("daily.backfillDone", { touched, skipped }));
}
```

Notice text (en): "Backfilled {touched} day(s) into Daily Notes;
{skipped} skipped (missing file or already had markers)."

Same safety rules: past days with existing markers are **never**
overwritten by backfill. This is intentional — if user wants to
refresh a specific past day, they delete the markers manually and
next sync re-fills.

### Path computation

We use Obsidian's bundled `moment.js` (already available globally):

```typescript
function computeDailyNotePath(date: string): string {
  const m = window.moment(date, "YYYY-MM-DD");
  const formatted = m.format(settings.dailyNotesFilenameFormat);
  return normalizePath(`${settings.dailyNotesFolder}/${formatted}.md`);
}
```

Examples:
- folder=`"Daily"`, format=`"YYYY-MM-DD"`, date=`"2026-05-11"`
  → `"Daily/2026-05-11.md"`
- folder=`"01 Daily"`, format=`"YYYY/YYYY.MM.DD"`, date=`"2026-05-11"`
  → `"01 Daily/2026/2026.05.11.md"`
- folder=`""`, format=`"YYYY-[W]ww/YYYY-MM-DD"`, date=`"2026-05-11"`
  → `"2026-W20/2026-05-11.md"`

### Settings UI (Daily Notes tab)

Lives in the spec-0005 `daily` tab. Layout:

```
┌─────────────────────────────────────────────────┐
│ [Toggle] Enable Daily Notes integration         │
│                                                 │
│ When enabled, the plugin will insert per-event  │
│ lines into your Daily Note for each sync, in    │
│ a marker-bounded region. Past days with         │
│ existing markers are never modified.            │
│                                                 │
│ [Folder selector] Daily Notes folder            │
│ [Text input]     Filename format (Moment.js)    │
│                                                 │
│ ─── Markers ───                                 │
│ [Text input] Start marker                       │
│ [Text input] End marker                         │
│   "Tip: use %% comments %% for invisible,       │
│    or ## Heading for visible."                  │
│                                                 │
│ ─── Entry format ───                            │
│ [Text input] Entry template                     │
│   "Placeholders: {{time}} {{action}} {{display}}"│
│   "Entry language follows your Metadata        │
│    language setting (currently: zh-CN)."        │
│                                                 │
│ Preview:                                        │
│ ┌─────────────────────────────────────────┐    │
│ │ 10:00 — 看了 低智商犯罪 (2026) S1E16    │    │
│ │ 14:30 — 加入想看 重生 (2020)            │    │
│ │ 21:30 — 看了 黑暗骑士 (2008)            │    │
│ └─────────────────────────────────────────┘    │
│                                                 │
│ ─── Manual backfill ───                         │
│ [Slider 1-30] Backfill days: 7                  │
│ [Button] Backfill last 7 days into Daily Notes  │
│                                                 │
│ ─── Source events that appear ───               │
│ • Watched: requires Sync watch history          │
│            (detailed)                           │
│ • Added to watchlist: requires Sync watchlist   │
│ • Favorited: requires Sync favorites            │
│ • Rated: requires Sync ratings                  │
└─────────────────────────────────────────────────┘
```

The preview is live — re-renders as user changes template / language.
3 hardcoded sample events covering show-with-episodes / watchlist /
movie. The "Source events" table is static help text.

### Sync engine wiring

In `SyncEngine.sync()`, after step 7 (`saveSettings`) but before step 8
(notice), add:

```typescript
// 7.5 — [0.7.0] Daily Notes catch-up
if (this.settings.dailyNotesEnabled) {
  try {
    await this.dailyNotes.processCatchUp(merged);
  } catch (e) {
    console.warn("[Traktr] Daily Notes catch-up failed:", e);
    // Don't fail the sync — Daily Notes is a side effect, not the main job
  }
}
```

A failure in Daily Notes processing **must not** roll back the main
sync. Best-effort.

### Command palette

New command: `Traktr: Sync to Daily Notes (today only)` — useful when
user just wants to refresh today's entries without a full sync. Calls
`processDate(today, { mode: "today" })` directly, bypassing catch-up.

## Edge cases (the safety contract)

The whole point of this spec is "we never corrupt the user's Daily
Notes." Every scenario below was considered explicitly:

| # | Scenario | Behavior |
|---|---|---|
| 1 | Past day: file doesn't exist | Skip silently. Cursor advances. |
| 2 | Past day: file exists, no markers | Insert block + markers at end of file. |
| 3 | Past day: file exists, valid marker pair | **Skip** (add-only rule). Cursor advances. |
| 4 | Today: file doesn't exist | Skip silently. Cursor does NOT advance past today. |
| 5 | Today: file exists, no markers | Insert block + markers at end. |
| 6 | Today: file exists, valid marker pair | Replace content between markers with fresh block. |
| 7 | Markers present but malformed (only start, only end, end before start) | Treat as "no valid markers" → fall through to "no markers" path. |
| 8 | Markers present + duplicate (e.g. user pasted twice) | `indexOf` finds the first. We replace between first start and the next end after it. Subsequent markers untouched. Acceptable behavior; user should clean up duplicates manually |
| 9 | Event source disabled (e.g. `syncWatchlist=false`) | Watchlist events excluded from aggregation. No empty placeholders. |
| 10 | Two watch events at exactly same timestamp, same show | Comma-merge episode list in one line. |
| 11 | Two watch events at exactly same timestamp, different shows | Two separate lines. |
| 12 | Catch-up range huge (months/years) | Clip to last 90 days (`SAFETY_CAP`). Skipped older days not retroactively filled — user can use manual backfill to N=30 max if they want some of it |
| 13 | Clock skew: event timestamp in future | Local-time conversion uses real timestamp regardless. May land on tomorrow's daily. Rare, not blocking |
| 14 | Time zone changes during catch-up | Use system local TZ at sync time. Past events bucket by their UTC → current-TZ conversion. Stable within a single sync run |
| 15 | DST transition within catch-up range | moment.js handles. Hour gap on spring-forward = no events that hour; fall-back = events possible at duplicate clock times |
| 16 | metadataLanguage changed | Today's daily is re-rendered in new language on next sync. Past days NOT retroactively updated (would require overwriting their markers, violating add-only) |
| 17 | User customized markers mid-flight | Past notes keep old markers (forever, unless user manually edits). New writes use new markers. No mass migration |
| 18 | Empty events for a date (nothing happened) | Don't write empty block. Skip date silently. Cursor advances |
| 19 | Markers exist but block inside emptied (user deleted contents but kept markers) | Today: re-fill. Past: skip (markers present, add-only rule respected) |
| 20 | Multi-device race: Mac and iPhone both syncing same date | Today: both overwrite with same content (idempotent — same events from shared historyState produce same block). Past: whichever device fills first establishes markers; the other sees markers and skips |
| 21 | Filename format includes unsupported chars (e.g. `:` on Windows) | `normalizePath` sanitizes. If still invalid, write throws; we catch and skip (logged warning) |
| 22 | Folder doesn't exist | Same as file missing — skip silently |
| 23 | Trakt event id deduplication | Already handled by historyState merge (spec 0001). Daily Notes consumes pre-deduped data |
| 24 | `dailyNotesEnabled=false` mid-flight | Catch-up is skipped from that sync onward. Existing markers in past notes stay; no retroactive cleanup |
| 25 | Master sync fails before reaching daily-notes step | `dailyNotes.processCatchUp` doesn't run that sync. `lastDailyNoteSyncedAt` stays at previous value. Retries on next sync |
| 26 | User toggles `syncFavorites` mid-day after seeing yesterday's favorite events in daily | Yesterday's daily already has markers, won't change. Today's daily on next sync will exclude favorites (because source flag now off) |

## Acceptance criterion (data integrity)

> **For every Daily Note file on disk, content outside the
> marker-bounded region must be byte-for-byte identical before and
> after every catch-up run. No exceptions.**

This is enforced by `replaceMarkerBlock` only modifying `[startIdx,
endIdx + markerEnd.length)` and `appendBlock` only adding after the
existing content (no in-place edits). New smoke tests assert this.

## Tests

`tests/i18n.smoke.ts`:

**Event aggregation**:
- Single watched event for movie → one entry
- Two watched events for same show, same timestamp → comma-merged
- Two watched events for same show, different timestamps → two lines
- Mixed movie + show events on same date → sorted by time
- Source flag off → corresponding events excluded
- Localized verbs in en + zh-CN

**Path computation**:
- format=`YYYY-MM-DD` + folder=`Daily` + date 2026-05-11 → `Daily/2026-05-11.md`
- format=`YYYY/YYYY.MM.DD` + folder=`01 Daily` + date → nested path
- format with weekly bucket → `2026-W20/2026-05-11.md`

**Marker detection**:
- Valid pair → true
- Missing start → false
- Missing end → false
- End before start → false
- Empty content → false

**Block rendering**:
- Empty events → empty block (omitted)
- Markers in user's preferred language
- Warning comment in user's UI language
- Time format HH:MM
- Display string for movie / show single / show merged

**Catch-up logic**:
- First run with no `lastDailyNoteSyncedAt` → only today processed
- Multi-day gap → all dates iterated
- Cap at 90 days when gap exceeds
- Cursor advances only on successful processDate

**Marker-region replacement** (the critical safety test):
- Content before markers preserved byte-for-byte
- Content after markers preserved byte-for-byte
- Multiple syncs idempotent for today
- Past day with markers: no modification

**End-to-end "no corruption" assertion**:
- Random Daily Note content + insert + extract → outside-region equals original

Estimated: 25-30 new test cases.

## Implementation surface

| File | Change | Estimated LOC |
|---|---|---|
| `src/daily-notes.ts` (new) | Event aggregation, path computation, marker handling, catch-up algorithm, block rendering | ~300 |
| `src/types.ts` | New `DailyNoteEvent`, `EventAction` types; add `lastDailyNoteSyncedAt` to `HistoryState` | ~20 |
| `src/settings.ts` | New 7 settings fields + defaults; Daily Notes tab UI in spec-0005 tab framework | ~250 |
| `src/sync-engine.ts` | Call `dailyNotes.processCatchUp` at end of `sync()` | ~10 |
| `src/main.ts` | Register `Traktr: Sync to Daily Notes` command | ~15 |
| `src/i18n.ts` | Verb keys, settings labels, warning comment, button text, notice strings (en + zh-CN) — estimate 30 new keys × 2 langs | ~120 |
| `src/history-state.ts` | Add `lastDailyNoteSyncedAt` to `EMPTY_HISTORY_STATE` + state-from-events helper | ~10 |
| `tests/i18n.smoke.ts` | 25-30 new cases | ~400 |
| `styles.css` | `.trakt-daily-preview` + `.trakt-daily-help` classes | ~30 |
| `docs/CHANGELOG.md` | 0.7.0 entry | ~50 |
| `docs/MANUAL.md` + 3 translations | New "Daily Notes integration" section | ~150 each = ~600 |

Total estimate: ~1100 LOC of code + 400 LOC of tests + 800 LOC of docs.
Easily the largest single release in the project's history. Worth
splitting into phases during implementation:

- **Phase 1**: Core lib (`daily-notes.ts`) + tests in isolation (no UI)
- **Phase 2**: Settings UI tab + preview
- **Phase 3**: Sync engine wiring + command palette
- **Phase 4**: Docs + final smoke

## Migration

On first 0.7.0 launch:
- All new settings fields default-initialize per "Defaults" table above
- `lastDailyNoteSyncedAt` initializes to `""` (empty) in
  `EMPTY_HISTORY_STATE`. The first time a sync runs with
  `dailyNotesEnabled=true`, the catch-up algorithm sees empty and
  processes only today
- No data is modified anywhere unless user explicitly enables the
  feature

Users who want historical fill use the **Backfill** button after
enabling.

## Future work

- **Per-event-type templates** — different lines for watch vs rate
- **Visible-marker presets** — pre-baked options ("## 今日 Trakt",
  "horizontal rule") instead of free-form text
- **Custom verbs** — let users override the localized verbs
- **Sort modes** — group-by-type instead of pure chronological
- **Episode title in line** — `"S1E16: The Heist"` instead of just
  `"S1E16"`. Requires Trakt episode title from history endpoint
- **Backfill that overwrites past markers** — explicit "destructive
  backfill" with confirmation modal
