# 0008 — Metadata language fallback (strict primary + user-defined secondary)

- **Status**: draft
- **Targeted**: 0.9.0
- **Date**: 2026-05-13
- **Authors**: @o1xhack, Claude

## Context

The plugin currently fetches localized metadata (title / overview /
tagline / genres) through one of two paths:

1. **TMDB path** (has TMDB key + the item has a tmdb_id) — we call
   `/movie/{id}?language=zh-CN`. TMDB's internal fallback then picks
   what to return: typically the requested locale if present, else
   the movie's default language data (often English). **We have no
   visibility or control over which.**
2. **Trakt translation path** (no TMDB key, or no tmdb_id for that
   item) — we call `/translations/zh` and get an array of every zh-*
   entry. [`pickTraktTranslation`](../../src/trakt-api.ts) then runs a
   loose 2-step fallback: exact `lang+country` match first, then the
   **first language-only match**. So `zh-CN` requested + only `zh-TW`
   available → returns the zh-TW entry.

Both paths share the failure mode that motivates this spec: the user
asked for **simplified Chinese**, didn't get it, and silently received
**traditional Chinese** (or vice versa). For people who care about the
distinction this is worse than just getting English, because the note
LOOKS localized and is harder to spot as wrong.

Two real user-facing requirements emerged:

- **Strict primary** — `zh-CN` should mean exactly zh-CN. zh-TW must
  not substitute.
- **Configurable secondary fallback** — if primary really doesn't
  exist, try this language next (default English) before giving up
  and keeping the English original.

## Goals / Non-goals

### Goals

- New setting `metadataFallbackLanguage: string`, BCP-47 code or `""`
- Setting `""` = current loose behaviour (zero-migration default for
  existing users)
- Setting a code = **strict primary + strict fallback + English original
  as final**
- Works on **both** the TMDB path and the Trakt translation path
- Surfaces only when localization is on (i.e. primary `metadataLanguage`
  is set) — no point asking for fallback when there's no primary
- UI text in both English and zh-CN, matching the existing pattern in
  the Localization section

### Non-goals

- **Renaming files** when the title changes language — that's a
  separate, larger change. See [spec 0009](0009-filename-rename.md)
  (targeted 1.0.0)
- Multi-level fallback (e.g. primary → fallback1 → fallback2 → English).
  Two levels of user-chosen + English original at the end is enough; a
  longer chain would explode the UI for marginal benefit
- Per-item override (a way to pin one specific note to a different
  language). Niche; can revisit if asked for
- Controlling TMDB's *internal* fallback behaviour when we're NOT in
  strict mode. TMDB's behaviour with `?language=zh-CN` stays
  unchanged when the user doesn't set a fallback

## Design

### Settings shape

```ts
export interface TraktrSettings {
  // ... existing fields ...
  metadataLanguage: string;             // existing: primary (e.g. "zh-CN")
  customMetadataLanguage: string;       // existing: when metadataLanguage === "custom"
  metadataFallbackLanguage: string;     // NEW: BCP-47 code, "" = disabled
}
```

Default: `metadataFallbackLanguage: ""` — preserves the loose-match
behaviour for users upgrading from 0.8.x without any action on their
part.

### Decision matrix (per item, per sync)

Let `P` = effective primary (from `metadataLanguage` /
`customMetadataLanguage`), `F` = effective fallback
(`metadataFallbackLanguage`).

| `P` set? | `F` set? | Behaviour |
|---|---|---|
| no | (n/a) | Localization off — English original, no API translation calls (existing) |
| yes | no | **Loose match** on primary: exact then language-prefix. Current 0.8.x behaviour (zero change) |
| yes | yes | **Strict match** primary → **Strict match** fallback → keep English original |

Why "fallback set" implicitly switches to strict on the primary: setting
a fallback is itself a declaration of intent (*"I want zh-CN specifically;
if not zh-CN, English"*). Adding a separate "strict" toggle would let
users pick `primary=zh-CN, strict=on, fallback=""` which means "zh-CN
only, otherwise English" — which is exactly what `primary=zh-CN,
fallback=en` already does. One control instead of two.

### Trakt translation path (full control)

[`pickTraktTranslation(translations, language)`](../../src/trakt-api.ts)
becomes:

```ts
export function pickTraktTranslation(
  translations: TraktTranslation[],
  primary: string,
  fallback?: string,
): TraktTranslation | null {
  if (translations.length === 0) return null;

  // Always strictly-match the primary (exact lang+country, or lang-only
  // when no country in the primary code).
  const exactPrimary = strictMatch(translations, primary);
  if (exactPrimary) return exactPrimary;

  // Loose-match the primary IFF no fallback was requested. This keeps
  // the existing 0.8.x behaviour for users who haven't opted in.
  if (!fallback) {
    return looseMatch(translations, primary);
  }

  // Strict-match the fallback.
  const exactFallback = strictMatch(translations, fallback);
  if (exactFallback) return exactFallback;

  return null;
}
```

`strictMatch` requires exact lang+country agreement. When the requested
code is language-only (e.g. `ja` or `en`), it matches the first entry
with that language and ANY country — that's still "strict" because the
user only specified language-level granularity.

### TMDB path (use `/translations` endpoint)

When fallback is OFF: keep the current single call
`/movie/{id}?language=zh-CN`. Zero behaviour change.

When fallback is ON: switch to `/movie/{id}/translations` which returns
the full translation array, walk it ourselves with the same `strictMatch`
algorithm:

```ts
// Pseudocode
if (fallback) {
  const all = await fetchTmdbTranslations(id, type, apiKey);
  const picked =
    strictMatchTmdb(all, primary) ||
    strictMatchTmdb(all, fallback);
  return picked;
}
// else: existing single-call path
```

Trade-off: when fallback is ON, every translation lookup becomes one
extra API call. TMDB rate limit is 50 req/s, the existing
TMDB_CONCURRENCY=5 keeps us well below that. Acceptable for the
correctness gain — and users who don't enable fallback pay nothing.

### UI

In Settings → General → Localization, immediately below **Metadata
language**:

```
Metadata language:       [Chinese (Simplified) ▼]
Fallback language:       [English ▼]                    ← NEW
                         "If your metadata language has no translation
                         for an item, try this one. With fallback set,
                         the primary language becomes a strict match —
                         variants like zh-TW won't substitute for zh-CN.
                         English original is always kept as the final
                         fallback."
```

- Hidden / disabled when `metadataLanguage` is empty (localization
  off — no primary, nothing to fall back from)
- Disabled value: `""` ("No fallback") — preserves loose behaviour
- Same dropdown options as Metadata language minus the "custom" entry
  (a custom fallback adds complexity for very little real-world value)

### i18n keys

```
loc.fallbackLanguage.name     EN "Fallback language"           zh "回退语言"
loc.fallbackLanguage.desc     EN (above)                       zh (above, translated)
loc.fallbackLanguage.none     EN "No fallback (loose match)"   zh "不回退（宽松匹配）"
```

The `none` label spells out the trade-off so users understand picking
"none" isn't broken — it's the prior loose-match behaviour.

## Alternatives considered

### A. Add a separate `strictMetadataLanguage: boolean` toggle

Considered and rejected. Three controls (primary + strict + fallback)
where two suffice (primary + fallback, with fallback implying strict)
is just clutter. The "strict on, fallback empty" cell is unreachable
useful intent — anyone who wants strict matching also wants a fallback,
even if it's English.

### B. Multi-level fallback chain (primary → mid1 → mid2 → English)

Considered and rejected for now. A three-tier setup UI doubles in
complexity, and the realistic demand is "zh-CN, otherwise English" or
"zh-TW, otherwise English", not a 3-level chain. If it comes up, we
add it later.

### C. Always use TMDB's `/translations` endpoint

Cleaner conceptually but doubles TMDB API calls for everyone, including
users who don't care about strict matching. Keeping the dual code path
(loose = single call, strict = translations endpoint) opt-in to the
heavier path keeps zero-config performance the same.

### D. Filename rename in the same release

Considered and rejected for cohesion + risk reasons. The fallback
feature is a fairly contained metadata change. The rename feature
touches the vault filesystem and Obsidian's internal link graph, which
is a larger, riskier surface. Splitting them lets us validate fallback
correctness in 0.9.x before introducing rename in 1.0.0.

## Migration / backward compatibility

- New setting `metadataFallbackLanguage: ""` (default)
- No data.json migration needed — `Object.assign(DEFAULT_SETTINGS,
  loaded)` fills in the new field for existing users with the default
  value `""`
- Behaviour for upgraded users with `metadataFallbackLanguage === ""`:
  **byte-for-byte identical** to 0.8.x. Same API endpoints, same
  loose-match algorithm
- Cross-device sync: the new field follows the existing data.json
  sync layer. Mac and iPhone share one value (consistent with
  `metadataLanguage` itself, which is also vault-shared)
- The misleading description text on `loc.metadataLanguage.desc`
  ("changing the language will rename notes on next sync ...") stays
  unchanged in 0.9.0. It's still wrong, but spec 0009 (1.0.0) fixes
  both the description AND implements the rename it promises

## Tests

Smoke tests (new) in `tests/i18n.smoke.ts`:

- `pickTraktTranslation` — strict primary match
- `pickTraktTranslation` — strict primary miss → strict fallback match
- `pickTraktTranslation` — both miss → returns null
- `pickTraktTranslation` — language-only primary code (`ja`) matches any
  country-tagged ja entry
- `pickTraktTranslation` — without fallback param: backward-compatible
  loose-match (zh-CN finds zh-TW)
- `pickTraktTranslation` — with fallback param: strict (zh-CN does NOT
  find zh-TW)

TMDB path tests rely on a stubbed `fetchTmdbTranslations` (mirroring
how Trakt API tests use canned responses).

UI smoke checks:
- Setting appears in EN + zh-CN, both correctly worded
- Hidden when `metadataLanguage` is empty
- Dropdown excludes "custom"
- Selecting a value persists across reload (covered by existing
  saveSettings test)

**Manual verification before release** (the user's "测试好" requirement):

- [ ] Set primary=zh-CN, fallback=en, sync a movie that has only zh-TW
      on TMDB → note shows English (NOT zh-TW)
- [ ] Set primary=zh-CN, fallback=none, sync the same movie → note
      shows zh-TW (loose behaviour preserved)
- [ ] Switch UI language EN ↔ zh-CN → fallback setting's label +
      description render correctly in both
- [ ] Disable metadata language → fallback row disappears
- [ ] Cross-device: Mac sets fallback=en, sync → data.json propagates;
      iPhone next sync uses the same fallback chain

## Future work

- "Custom" fallback (free-form BCP-47 code) — punt until requested
- Per-item language override — punt
- TMDB's primary path also using `/translations` even without fallback,
  for full strict control everywhere — punt; current loose behaviour is
  what existing users have, breaking it requires a fallback-opt-in
  signal which is exactly what 0.9.0 introduces
