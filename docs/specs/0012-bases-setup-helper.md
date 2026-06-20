# 0012 — Bases setup helper

- **Status**: implemented
- **Released in**: N/A
- **Date**: 2026-06-20
- **Authors**: @o1xhack, Codex

## Context

The plugin already writes structured frontmatter properties to Markdown
media notes. Obsidian Bases can query those properties, but users
currently have to learn the `.base` YAML schema and manually reproduce
the plugin's notes-folder and property-prefix settings.

The helper reduces that setup work. It creates optional `.base` files
that point at the existing media notes; it does not introduce another
database or participate in sync.

## Goals

- Add a dedicated **Bases** settings tab.
- Persist a vault-relative `basesFolder` setting, defaulting to `Bases`.
- Persist independent display-field selections for every generated Base.
- Generate useful movie, show, watchlist, watched, ratings, and complete
  library Bases.
- Provide a dedicated all-in-one movie + TV library action.
- Let users expose any existing synced frontmatter property without
  editing YAML.
- Use the configured media-note folder and property prefix.
- Use only frontmatter fields already written by the note renderer.
- Keep generation local-only and independent from Trakt/TMDB sync.
- Confirm before replacing an existing `.base` file.
- Keep YAML generation deterministic and testable without Obsidian.

## Non-goals

- No new tracking database or cache.
- No changes to Trakt/TMDB requests, sync sources, note rendering,
  reconciliation, Daily Notes, authentication, or existing notes.
- No automatic regeneration when settings change.
- No background generation or network calls.
- No theme-specific CSS or dependency on external Bases plugins.

## Design

`src/bases.ts` owns two separate layers:

1. Pure generators:

   ```typescript
   buildBasePropertyName(prefix, key)
   buildMoviesBase(settings)
   buildShowsBase(settings)
   buildWatchlistBase(settings)
   buildWatchedBase(settings)
   buildRatingsBase(settings)
   buildLibraryBase(settings)
   getBaseFileDefinitions(settings)
   ```

2. Vault-writing helpers:

   ```typescript
   ensureBasesFolder(app, folder)
   writeBaseFile(app, folder, definition, confirmOverwrite)
   ```

The generator uses the documented Obsidian Bases YAML sections:
`filters`, `formulas`, `properties`, and `views`. Filters use documented
expressions such as `file.inFolder()`, `file.hasProperty()`, boolean
comparisons, and numeric comparisons. Note properties use bracket
notation (`note["property_name"]`) in expressions so generated formulas
remain valid when a custom property prefix is used.

Each generated Base contains two views:

- a poster-first Cards view using `image()`, `imageAspectRatio: 1.5`,
  `imageFit: cover`, and a compact card size;
- a Details table with a poster formula column, formatted ratings,
  selected metadata, useful column widths, and medium row height.

Rating formulas avoid exposing Trakt's raw floating-point precision in
the UI. Each Base also has a purpose-specific numeric/date sort order.

Every Base is constrained to the configured media-note folder and to
notes carrying the configured type property. This prevents unrelated
vault files from appearing when the media folder contains mixed content.

`BASE_DISPLAY_FIELD_DEFINITIONS` is the shared ordered registry for the
settings UI and YAML generator. It contains 44 selectable fields grouped
as core metadata, ratings, viewing activity, TV progress, release details,
localization, IDs/links, and sync metadata. Each entry maps a stable
settings ID to either an existing frontmatter property, `tags`, or a
display-only formula.

Poster and note title are fixed structural fields. The selected fields are
used for both the Cards view and Details table so the two views stay
consistent. `episode_progress` is derived from existing
`episodes_watched / aired_episodes` values and does not change the note
schema. The exact latest season/episode reached is not available because
the renderer does not currently persist it as frontmatter.

## Settings

`TraktrSettings` gains:

```typescript
basesFolder: string;
basesDisplayFields: BaseDisplaySettings;
```

The folder default is `Bases`; each Base also has a curated default field
selection. A missing per-Base selection falls back to that Base's default;
unknown field IDs are ignored; valid selections are normalized to the
canonical registry order. An intentionally empty selection remains empty.
Existing installations receive the defaults through the existing settings
load. These fields remain vault-synced like other content-layout settings.

## UI

A fifth settings tab, **Bases**, contains:

- explanatory local-only/sync-independent help text;
- a **Bases folder** text field;
- an emphasized **Create All-in-one Base** action;
- individual create buttons for Movies, Shows, Watchlist, Watched, and
  Ratings;
- **Create All Bases**, which also creates `Trakt Library.base`.
- expandable per-Base field choosers with **Recommended**, **Select all**,
  and **Clear** controls.

Button actions call only the Bases module and Obsidian vault APIs. They
do not call `SyncEngine`.

## File generation behavior

Generated files:

| File | Filter |
|---|---|
| `Movies.base` | configured type property equals `movie` |
| `Shows.base` | configured type property equals `show` |
| `Watchlist.base` | configured watchlist property equals `true` |
| `Watched.base` | configured watched property equals `true` |
| `Ratings.base` | configured personal-rating property exists and is greater than `0` |
| `Trakt Library.base` | media-note folder plus configured type property |

Columns are drawn only from fields currently produced by
`buildFrontmatterData`. The registry includes all core, source, link,
localization, tag, and sync metadata, plus display formulas for poster,
formatted ratings, combined library status, and episode progress.

Nested Bases folders are created one segment at a time through
`app.vault.createFolder`. Files are created with `app.vault.create` and
updated with `app.vault.modify`.

## Overwrite behavior

Before modifying an existing target file, the settings UI opens the
shared confirmation modal with the filename and vault path. Canceling
leaves the file unchanged and generation continues to the next file
during **Create All Bases**. Confirming replaces the entire `.base`
file, including manual edits.

The overwrite path never reads or writes Markdown media notes.

## i18n

All tab labels, help text, controls, confirmation text, error text, and
Notices live in `src/i18n.ts` with English and Simplified Chinese
values. Localized user manuals retain their existing setting-row parity.

## Testing

The smoke suite verifies:

- custom property prefixes are respected;
- generated YAML is deterministic;
- all six expected filenames are returned in stable order;
- the all-in-one Base does not filter out either media type;
- custom per-Base selections control both card and table order;
- every field-registry label resolves in both UI languages;
- custom-prefix output does not contain `trakt_`;
- every property in the registry is produced by the union of comprehensive
  movie and show frontmatter;
- every preset contains a Cards view, poster formula, portrait aspect
  ratio, formatted ratings, and a secondary Details table;
- nested folder creation and create/skip/update overwrite behavior use
  the vault helper contract;
- Bases i18n and Notice/confirmation keys resolve in both UI languages.

Real Obsidian vault integration, overwrite modal interaction, and visual
Bases loading remain manual tests, consistent with the repository's
existing testing boundary.

## Alternatives considered

### Add a new database or index file

Rejected. The Markdown notes and their properties are already the source
of truth. A second data store would create reconciliation and migration
problems and would violate the local-note architecture.

### Generate only a conservative table

Initially implemented, then rejected after visual testing. It exposed raw
property names, long floating-point ratings, and the poster URL as text,
which did not match the poster-led library already demonstrated in the
README. The generated Cards view now uses syntax emitted by Obsidian
itself, while retaining a compact secondary table for detailed work.

### Put the controls in the Notes tab

Rejected because the existing tab bar already wraps on narrow screens
and Bases is a distinct optional workflow. A dedicated tab keeps the
Notes tab from growing further.

## Migration / backward compatibility

No explicit migration is required. Existing settings load with
`basesFolder: "Bases"` and curated per-Base display defaults. No existing
files are created until the user presses a generation button. Existing
`.base` files are never replaced without confirmation.

## Future work

- Persist an exact latest season/episode frontmatter field if a future
  schema change is justified.
- A preview/diff screen before overwrite if users need more granular
  preservation of manual Base edits.
