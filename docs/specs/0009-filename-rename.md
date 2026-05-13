# 0009 — Filename rename on title / language change

- **Status**: draft
- **Targeted**: 1.0.0
- **Date**: 2026-05-13
- **Authors**: @o1xhack, Claude

## Context

The settings description for `metadataLanguage` currently claims:

> If your filename template uses `{{title}}`, changing the language
> will rename notes on next sync — consider switching to
> `{{original_title}} ({{year}})` first.

**This is false.** Verified via:

- `grep -rn "rename\|renameFile" src/` returns zero hits except the
  description string itself
- `git log --all -S "vault.rename"` and `git log --all -S "renameFile"`
  return zero results — rename was **never implemented in any prior
  version**
- The reconcile path (`scanExistingNotes` → match by `trakt_id` in
  frontmatter → update in place via `vault.process` or
  `processFrontMatter`) explicitly never touches the file path

The user-visible failure mode this produces:

1. User installs plugin with `metadataLanguage=zh-CN`. Movie has only
   zh-TW on TMDB. Loose fallback returns zh-TW. File created as
   `黑暗騎士 (2008).md`.
2. User upgrades to 0.9.0 (spec 0008), sets `fallbackLanguage=en` to
   force strict zh-CN. Next sync: `trakt_title` updates to "The Dark
   Knight" (English), but the **file is still named `黑暗騎士 (2008).md`**.

You end up with traditional-Chinese filenames containing
English-titled content. Worse than the original silent fallback bug.

The two problems to solve:

1. **Implement the rename the description has been promising.** Use
   Obsidian's `fileManager.renameFile` so internal links to the
   renamed notes auto-update
2. **Fix the description** — even after rename ships, the current
   wording is misleading about what the user needs to do

## Goals / Non-goals

### Goals

- On every sync, after we've matched an existing note via `trakt_id`,
  compute its **desired** filename from the current item + template
  + disambiguator. If desired ≠ actual, rename via
  `app.fileManager.renameFile`
- Internal Obsidian links to the renamed file are preserved (this is
  `fileManager.renameFile`'s entire purpose vs `vault.rename`)
- Filename collisions (e.g. multiple shows with localized title `重生`)
  are handled by `disambiguatedFilename`, same as the create path —
  including correctly excluding the file BEING renamed from the
  collision check so it doesn't always tier up against itself
- Opt-in setting `autoRenameOnLanguageChange: boolean` for users who
  want the prior behaviour (no rename) — default ON to match the
  description that's been there since 0.3.x
- One-shot manual button "Rename existing notes to current language"
  in Settings → Notes (in case auto-rename was off, or the user
  wants to trigger it without a full sync)
- Fix the misleading description text on `metadataLanguage` (EN + zh-CN)

### Non-goals

- Renaming notes in folders OTHER than the configured sync folder —
  the plugin owns its sync folder; anything the user moved elsewhere
  is their responsibility
- A "preview rename plan" dialog — for now, run-and-rely-on-undo (git
  / cloud sync / Obsidian's own undo). If user demand surfaces, can
  add a confirmation modal later
- Renaming the folder itself when the user changes `settings.folder` —
  out of scope for this spec; tracked separately if it becomes a
  request

## Design

### Settings shape

```ts
export interface TraktrSettings {
  // ... existing fields ...
  autoRenameOnLanguageChange: boolean;  // NEW: default true
}
```

Default `true` because:

- The existing description promised this behaviour for ages
- Users who actually want "rename never happens" can flip it off
- The alternative (default off) would mean upgrading users see no
  rename happen and assume 1.0 didn't fix anything

### Reconcile path change

Today (0.8.x):

```ts
for (const [key, item] of mergedItems) {
  const existingFile = localNotes.get(key);
  if (!existingFile) {
    // CREATE — disambiguatedFilename + vault.create
  } else if (overwriteExisting) {
    // OVERWRITE — vault.process replaces full content
  } else {
    // DIFF — frontmatter + body diff, write only if changed
  }
}
```

New (1.0.0):

```ts
for (const [key, item] of mergedItems) {
  const existingFile = localNotes.get(key);
  if (!existingFile) {
    // CREATE — unchanged
  } else {
    // NEW: rename-if-needed FIRST, then existing update logic
    if (settings.autoRenameOnLanguageChange) {
      const desired = disambiguatedFilename(item, settings.filenameTemplate,
        candidate => {
          // CRITICAL: exclude the file being renamed from collision check.
          // Without this, existingFile always collides with itself and
          // disambiguator tiers up forever.
          const path = normalizePath(`${folderPath}/${candidate}.md`);
          const found = app.vault.getAbstractFileByPath(path);
          return found !== null && found !== existingFile;
        });
      const desiredPath = normalizePath(`${folderPath}/${desired.filename}.md`);
      if (existingFile.path !== desiredPath) {
        await app.fileManager.renameFile(existingFile, desiredPath);
        // existingFile (TFile reference) stays valid — Obsidian mutates
        // .path and .name in place during renameFile; the existing
        // diff/overwrite logic below uses the same reference and still
        // works.
        result.renamed++;
      }
    }
    // ... existing diff or overwrite logic, unchanged
  }
}
```

`SyncResult` gains a `renamed: number` counter, surfaced in the
post-sync notice ("Sync Trakt: 5 new, 2 updated, 3 renamed, ...").

### Why `fileManager.renameFile` (not `vault.rename`)

Both move the file. The difference:

- `vault.rename` just renames the file. Internal Obsidian links like
  `[[黑暗騎士]]` referring to it become broken
- `fileManager.renameFile` renames the file AND walks the metadata
  cache to rewrite every internal link pointing at the old name

For a sync tool that creates ~1000 notes, broken links across the
entire vault on every language change would be catastrophic. We must
use `fileManager.renameFile`.

### Self-collision exclusion

The bug-trap: `disambiguatedFilename`'s default
`existsCheck(candidate)` uses `vault.getAbstractFileByPath`, which
returns the file being renamed as "exists". So tier-0 collides → tier-1
collides → tier-2 (filename = title + year + tmdb_id) is unique only
because of the appended id. Result: every rename promotes to tier 2,
even when the natural tier-0 name would have been fine and free.

Fix in the per-call closure (shown in the snippet above): treat "this
existing file is the candidate" as not-a-collision.

### Manual rename button

Placement: **Settings → General → Localization**, immediately below
**Fallback language** (the 0.9.0 addition). Putting it here because:

- The trigger event ("I changed my language settings") and the
  remediation action ("rename existing notes to match") belong next
  to each other
- The misleading description that motivated this whole spec lives on
  `Metadata language` in this same section — fixing it in place is
  natural
- Auto-rename toggle + manual button + the underlying language
  dropdowns form one coherent "language strategy" block

The Notes tab was the obvious alternative (filename template lives
there), but the typical trigger is language change, not template
change — so Localization wins.

UI:

```
Auto-rename on language change: [✓]
"When you change Metadata language or Fallback language, existing
notes are renamed on the next sync to match the new title. Internal
Obsidian links auto-update. Note content (frontmatter + body) is
updated either way; this only controls the filename."

Rename existing notes now
"Walk every note in your sync folder and rename it to match your
current language + filename-template settings. Useful when
auto-rename was off, or to apply changes without waiting for the
next sync. Note content is not touched."

[ Rename now ]
```

Implementation: same loop as the reconcile path's rename step, but
standalone — doesn't need a full sync, just walks the sync folder,
reads each note's `trakt_id`, re-renders desired filename, renames
if different. Surfaces a post-run notice ("Sync Trakt: renamed
{n} note(s)").

### Fix the description

Current EN description for `loc.metadataLanguage.desc`:

> ...If your filename template uses `{{title}}`, changing the language
> will rename notes on next sync — consider switching to
> `{{original_title}} ({{year}})` first...

New EN description:

> ...If your filename template uses `{{title}}`, changing the language
> will rename existing notes on next sync (or when you click "Rename
> all notes" in the Notes tab). Internal Obsidian links auto-update.
> Disable this in **Auto-rename on language change** if you'd rather
> rename manually...

Same shape in zh-CN.

## Alternatives considered

### A. Manual-only rename (no sync-time auto-rename)

Reject. The current description has been promising auto-rename for so
long that some users expect it. Default-on auto-rename matches the
description; users who want manual control can flip the setting.

### B. Use `vault.rename` (without link update)

Reject. See "Why fileManager.renameFile" above. Link breakage on a
sync tool that manages hundreds of notes is unacceptable.

### C. Compute desired filename in a separate pass before the main reconcile loop

Marginal benefit (small parallelism gain). Significant risk: rename
batch + then update batch means two passes over the vault, two windows
in which the user could open Obsidian and observe inconsistent state.
The chosen per-item rename-then-update keeps the per-note transition
atomic from the user's perspective.

### D. Make rename a separate command (no setting, no auto)

Reject. Setting + button are not mutually exclusive — having both
gives users the choice. The setting controls the default behaviour,
the button is a one-shot for when default is off OR user wants to
trigger without a full sync.

## Migration / backward compatibility

- New setting `autoRenameOnLanguageChange: true` (default)
- Existing users upgrading from 0.9.x: on the next sync, any note
  whose current filename ≠ desired filename gets renamed. **This is
  intentional and matches the long-broken description.** First-1.0
  launch surfaces a one-time **modal dialog** (not a passive `Notice`
  — those auto-dismiss in 5s and the user might miss them):

  ```
  ┌─────────────────────────────────────────────────────┐
  │ Sync Trakt 1.0 — Auto-rename on language change     │
  ├─────────────────────────────────────────────────────┤
  │ Existing notes will now be renamed when you change  │
  │ your metadata language, so filenames stay in sync   │
  │ with the title language.                            │
  │                                                     │
  │ • Renames happen on the next sync (or manually via  │
  │   Settings → Localization → "Rename now")           │
  │ • Note content is unaffected — only the filename    │
  │   changes                                           │
  │ • Internal Obsidian links auto-update               │
  │                                                     │
  │ This is enabled by default. You can turn it off in  │
  │ Settings → Localization at any time.                │
  │                                                     │
  │              [ Disable for now ]  [ Keep enabled ]  │
  └─────────────────────────────────────────────────────┘
  ```

  - **"Keep enabled"** dismisses the dialog; setting stays on
  - **"Disable for now"** sets `autoRenameOnLanguageChange = false`
    and dismisses
  - Either way, a flag (e.g.
    `historyState.firstOneZeroNoticeShown: true`) prevents re-showing.
    Stored in `historyState` (not localStorage) so cross-device users
    don't see the dialog twice (once per device).
  - Backed by an Obsidian `Modal` subclass, same pattern as the
    existing `BackfillConfirmModal`
  - Localized in EN + zh-CN to match the rest of the UI surface

- Users who'd rather keep 0.9.x behaviour: flip the setting off before
  the first 1.0 sync. The first-launch notice should tell them how.

- Cross-device: `autoRenameOnLanguageChange` is data.json-synced (like
  the rest of the localization stack). Mac and iPhone share one value.

## Tests

Smoke tests (new):

- `disambiguatedFilename` with self-exclusion closure: rename target
  exists at tier-0 → still returns tier-0 (no false collision)
- Reconcile path: existing note + same language → no rename
- Reconcile path: existing note + language switch → rename to new title
- Reconcile path: rename target name collides with a DIFFERENT existing
  note (real collision) → disambiguator tiers up correctly
- Reconcile path: setting off → no rename even when title changed

**Manual verification before draft release** (the user's "测试好"
requirement, expanded for 1.0):

- [ ] Create a vault with 5 notes synced under zh-CN where loose fallback
      returned mixed zh-CN / zh-TW filenames. Switch to strict zh-CN +
      en fallback (requires 0.9.0 shipped). Sync. Verify:
  - [ ] All 5 files renamed to either zh-CN or English titles
  - [ ] Note content updated in step with rename
  - [ ] Internal `[[wiki-link]]` references inside OTHER notes (Daily
        Notes, hand-written notes) point at the new names
- [ ] Trigger collision: create 2 shows that share `{{title}} ({{year}})`
      under zh-CN. Sync. Verify tier-1 / tier-2 disambiguation applies
      same as the create path
- [ ] Toggle `autoRenameOnLanguageChange` off. Switch language. Sync.
      Verify NO renames happened
- [ ] Click "Rename all notes" button with the setting off. Verify
      rename happens once
- [ ] EN ↔ zh-CN UI language switch: setting label, button text,
      first-launch notice, post-sync count all render correctly in
      both
- [ ] Daily Notes integration is unaffected: marker regions in past
      days are still preserved byte-for-byte after rename runs
- [ ] Cross-device sync: rename happens on Mac → vault sync propagates
      file rename to iPhone → iPhone's plugin sees the new name and
      doesn't treat it as a fresh note (matched via `trakt_id` in
      frontmatter as today)
- [ ] First-1.0-launch notice: fires exactly once, flag prevents
      re-fire on subsequent launches

**Release process for 1.0.0** (per the user's explicit ask):

1. All automated checks green (lint + build + full smoke test suite)
2. Manual verification matrix above all green
3. Run release script with `RELEASE_SKIP_GH=1` so the script doesn't
   try to create a GitHub Release immediately
4. Or: run script normally, but **only publish the GitHub Release as
   draft** (don't promote to published until user explicitly approves)
5. README + 9 i18n READMEs updated to reflect 1.0 surface (new
   setting, new button, rename behaviour)
6. Wait for user "ship it" before publishing draft release

## Future work

- A "dry-run" mode for the Rename button (show what would change,
  before doing it)
- Rename when `settings.folder` changes (move all notes between
  folders) — natural extension of this work, distinct enough to
  warrant a separate spec if requested
- Per-note "lock" frontmatter field (`trakt_rename_locked: true`) so
  users can pin individual notes to their current name regardless of
  the global setting — punt until asked for
