# 0005 — Settings UI tab navigation

- **Status**: draft (awaiting user approval)
- **Targeted**: 0.6.0
- **Date**: 2026-05-11
- **Authors**: @o1xhack, Claude
- **Paired with**: [0006-daily-notes-integration](0006-daily-notes-integration.md) — the UI refactor here is the prerequisite that lets 0006 add a "Daily Notes" tab without making the settings page even longer

## Context

After 0.5.x, the settings tab is **>1000 lines of `Setting` instantiation**.
Approximately 30 distinct settings split across:

- Authentication (Trakt client id, secret, connect button, sync notice)
- TMDB (API key, test button, poster size, cache TTL, cache clear)
- Localization (metadata language, custom code, template language, UI language)
- Notes (folder, filename, propertyPrefix, movie template, show template)
- Tags + Tag notes
- Sync sources (watchlist, watched, watched detail, favorites, ratings, movies, shows)
- Sync behavior (startup, auto-sync, interval, overwrite, deleteRemoved, history full-refresh)
- Reset

Real-world feedback (0.5.x BRAT installs): users struggle to find specific
settings, scroll fatigue is real on mobile. The upcoming spec 0006 (Daily
Notes integration) adds another 6-8 settings — single-scroll view would
be untenable.

Notebook Navigator and several other community plugins use top-of-page
horizontal tabs. We adopt the same pattern.

## Goals / Non-goals

### Goals

- Tab-based navigation at the top of the settings page
- All existing settings preserved verbatim — just regrouped by category
- Cloud icons (spec 0003) + Test button (0.3.2) + warning banners (0.3.2)
  continue to work in their new homes with no behavior change
- Last selected tab remembered **per device** (uses `localStorage` since
  the choice of "which tab I last looked at" doesn't need to sync)
- Mobile-friendly: tabs wrap on narrow screens, no horizontal overflow

### Non-goals

- Sub-tabs / nested navigation — flat is enough at this scope
- Search box within settings — overkill for ~30 settings
- Drag-to-reorder tabs — fixed order
- Settings hot-reload across tabs — re-render entire content area on
  tab switch (simpler, no perceptible cost)
- Backwards compat for old single-scroll URL anchors — there are none

## Design

### Tab list (left to right)

| Tab id | Label (en) | Label (zh-CN) | Contents |
|---|---|---|---|
| `api` | API | API | Trakt auth + Auth sync notice + TMDB key + Test button + Poster size + TMDB cache (TTL + clear) + Reset all |
| `notes` | Notes | 笔记 | Metadata language + Custom code + UI language (cloud icon) + Template language + Folder + Filename template + Property prefix + Movie template + Show template + Tags + Tag notes |
| `sync` | Sync | 同步 | Sync watchlist / watched / watched detail / favorites / ratings + Sync movies / shows + Sync on startup (cloud icon) + Auto-sync (cloud icon) + Auto-sync interval (cloud icon) + Overwrite existing body + Delete removed items + History full-refresh interval + Clear history state |
| `daily` | Daily Notes | 日记 | _Empty in 0.6.0_ — to be populated by spec 0006 in 0.7.0. Tab is visible but renders only a one-line placeholder: "Daily Notes integration coming in 0.7.0." |

The `daily` tab being visible-but-empty in 0.6.0 is deliberate — it
signals the feature is coming, and the empty state itself isn't bad
UX (one informational line).

### Tab persistence

```typescript
localStorage key: "sync-trakt:_activeSettingsTab"
value: "api" | "notes" | "sync" | "daily"
default: "api"
```

Stored device-local (via `app.saveLocalStorage`) — the choice of which
tab the user last looked at on Mac shouldn't sync to iPhone (each
device's last-viewed state is personal). Same mechanism we use for the
spec 0003 `_localKeys` list, so no new infrastructure needed.

### Implementation skeleton

Refactor `TraktrSettingTab.display()` into per-tab renderers:

```typescript
class TraktrSettingTab extends PluginSettingTab {
  private activeTab: SettingsTabId = "api";

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.activeTab = this.loadActiveTab();
    this.renderTabBar(containerEl);
    const content = containerEl.createDiv({ cls: "trakt-tab-content" });
    switch (this.activeTab) {
      case "api":    this.renderApiTab(content); break;
      case "notes":  this.renderNotesTab(content); break;
      case "sync":   this.renderSyncTab(content); break;
      case "daily":  this.renderDailyTab(content); break;
    }
  }

  private renderTabBar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "trakt-tab-bar" });
    for (const tab of TABS) {
      const btn = bar.createEl("button", {
        cls: "trakt-tab" + (tab.id === this.activeTab ? " is-active" : ""),
        text: t(`tabs.${tab.id}`),
      });
      btn.onclick = () => {
        this.activeTab = tab.id;
        this.saveActiveTab(tab.id);
        this.display();
      };
    }
  }

  private renderApiTab(c: HTMLElement): void {
    // existing Authentication section + TMDB section + Reset
  }
  // ... etc
}
```

Cloud icons (spec 0003), TMDB Test button, no-TMDB-key warning banner —
all unchanged, just re-homed inside their respective tab render methods.

### CSS

Add to `styles.css`:

```css
.trakt-tab-bar {
  display: flex;
  gap: 0.25em;
  margin-bottom: 1em;
  border-bottom: 1px solid var(--background-modifier-border);
  flex-wrap: wrap;  /* mobile: wrap to second row instead of overflowing */
}

.trakt-tab {
  padding: 0.5em 1em;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 1em;
}

.trakt-tab:hover {
  color: var(--text-normal);
}

.trakt-tab.is-active {
  color: var(--text-normal);
  border-bottom-color: var(--interactive-accent);
}
```

Existing `trakt-test-result` / `trakt-tmdb-warning` classes stay
untouched.

## Edge cases

| # | Scenario | Behavior |
|---|---|---|
| 1 | `localStorage` missing `_activeSettingsTab` | Default `"api"` |
| 2 | `localStorage` has unknown tab id (e.g. dropped tab from future version) | Fallback `"api"` |
| 3 | User on mobile / narrow screen | Tabs wrap to next line via `flex-wrap: wrap` |
| 4 | User changes a setting on one tab, switches tabs | Setting was saved synchronously on change; tab switch re-renders from current settings. No cross-tab pollution |
| 5 | Refresh / re-open settings | Opens to last-selected tab from `localStorage` |
| 6 | Tab labels in zh-CN | Translated via existing `t()` helper using `uiLanguage` setting |
| 7 | UI language switched while in settings (the language change happens on the Notes tab) | Tab labels re-render on next `display()` call (which fires when user clicks any tab) |

## Tests

This is a pure UI refactor with no new logic worth unit-testing. Test
surface:

- **New i18n keys for the 4 tab labels** exist in both `en` and `zh-CN`
  (covered by the existing pattern from spec 0004 — one new smoke case
  per language)
- **Manual smoke during release verification**:
  1. Open Settings → see 4 tabs
  2. Click each → see expected sections from the table above
  3. Toggle a setting on any tab → verify it persists (sync run, etc.)
  4. Restart Obsidian → settings opens to last-clicked tab

## Migration

None. No state schema change. The `_activeSettingsTab` localStorage
key is created on first 0.6.0 launch with default `"api"`. Users see
the new tabbed UI but every setting they've already configured is
still there (in the same group as before, just under a different tab
header).

## Implementation surface

| File | Change |
|---|---|
| `src/settings.ts` | Refactor `display()` into 4 per-tab render methods; add `renderTabBar`; add `activeTab` state + load/save helpers |
| `src/i18n.ts` | 4 new keys: `tabs.api`, `tabs.notes`, `tabs.sync`, `tabs.daily` (en + zh-CN) |
| `styles.css` | `.trakt-tab-bar`, `.trakt-tab`, `.trakt-tab.is-active` styles |
| `tests/i18n.smoke.ts` | 1 new case verifying the 4 tab keys resolve in both languages |
| `docs/CHANGELOG.md` | 0.6.0 entry |

Estimated LOC change: ~200 net (lots of indent + restructure, very
little new logic).

## Future work

- **Sub-grouping within tabs** if the daily tab grows beyond 8-10
  settings — but spec 0006 is well within budget
- **Settings search** — if user count grows and search becomes a real
  need. Not pressing.
