# 0007 — Template language expansion + dropdown filter

- **Status**: draft (will ship as part of 0.6.0 alongside spec 0005)
- **Targeted**: 0.6.0
- **Date**: 2026-05-11
- **Authors**: @o1xhack, Claude

## Context

The plugin currently has two language dropdowns in Localization:

- **Metadata language** — controls translation of title / overview /
  tagline / genres. Backed by TMDB which supports ~100 locales, so
  the dropdown lists 15 presets + a "custom" option.
- **Note template language** — controls which bundled template is
  used for the note body. **We only have 3 bundled templates**
  (en + zh-CN + zh-TW), but the dropdown **reuses the same 15-preset
  list as Metadata language**, so users can pick e.g. `ja-JP` and
  silently get the English template.

Real user complaint: "Why does the dropdown let me pick Japanese if
the actual template is English?"

This is a legitimate UX bug. Two ways to fix:

1. **Add bundled templates** for the missing languages
2. **Filter the dropdown** to only show languages we actually have

Both are needed. This spec covers both.

## Goals / Non-goals

### Goals

- Add bundled movie + show templates for **8 new languages**:
  ja, ko, fr, de, it, es, pt, ru
- Filter the **template language** dropdown to only show the
  11 bundled languages (en, zh-CN, zh-TW + 8 new)
- Daily Notes verb translations (spec 0006) cover the same 11
- **Metadata language** dropdown stays at 15+ presets — TMDB supports
  far more languages than we ship templates for, no reason to limit
- Translations are hand-curated, not machine-translated. Section
  headings, bullet labels, and stylistic conventions follow each
  language's idiomatic Markdown / note conventions

### Non-goals

- Translating the README / MANUAL / SETUP docs into 8 new languages —
  those stay at the current 9 languages (en + 8). MANUAL etc. are
  separate translation projects with much larger surface area
- Translating the plugin UI (settings tab, command names, notices)
  into 8 more languages — `uiLanguage` stays at en + zh-CN for now
- Custom template-language code support — drop the "Custom" option
  from the template dropdown. (Custom mode is still in Metadata
  language since that goes to TMDB)
- Re-rendering existing notes when user switches template language —
  same behavior as today (only new templates pick up the new lang;
  existing notes with their original templates can be manually
  reset via the per-template Reset button)

## Design

### Bundled template set

Add 16 new template constants to `src/settings.ts`:

```typescript
export const DEFAULT_MOVIE_TEMPLATE_JA = `...`;
export const DEFAULT_SHOW_TEMPLATE_JA = `...`;
export const DEFAULT_MOVIE_TEMPLATE_KO = `...`;
export const DEFAULT_SHOW_TEMPLATE_KO = `...`;
export const DEFAULT_MOVIE_TEMPLATE_FR = `...`;
export const DEFAULT_SHOW_TEMPLATE_FR = `...`;
export const DEFAULT_MOVIE_TEMPLATE_DE = `...`;
export const DEFAULT_SHOW_TEMPLATE_DE = `...`;
export const DEFAULT_MOVIE_TEMPLATE_IT = `...`;
export const DEFAULT_SHOW_TEMPLATE_IT = `...`;
export const DEFAULT_MOVIE_TEMPLATE_ES = `...`;
export const DEFAULT_SHOW_TEMPLATE_ES = `...`;
export const DEFAULT_MOVIE_TEMPLATE_PT = `...`;
export const DEFAULT_SHOW_TEMPLATE_PT = `...`;
export const DEFAULT_MOVIE_TEMPLATE_RU = `...`;
export const DEFAULT_SHOW_TEMPLATE_RU = `...`;
```

Section headings translated per language:

| en | zh-CN | zh-TW | ja | ko | fr | de | it | es | pt | ru |
|---|---|---|---|---|---|---|---|---|---|---|
| Synopsis | 剧情简介 | 劇情簡介 | あらすじ | 줄거리 | Synopsis | Inhalt | Sinossi | Sinopsis | Sinopse | Описание |
| Details | 详情 | 詳情 | 詳細 | 상세 정보 | Détails | Details | Dettagli | Detalles | Detalhes | Подробности |
| Trakt status | Trakt 状态 | Trakt 狀態 | Trakt の状態 | Trakt 상태 | Statut Trakt | Trakt-Status | Stato Trakt | Estado de Trakt | Status Trakt | Статус Trakt |
| Watch History | 观看记录 | 觀看紀錄 | 視聴履歴 | 시청 기록 | Historique | Verlauf | Cronologia | Historial | Histórico | История |
| Links | 链接 | 連結 | リンク | 링크 | Liens | Links | Link | Enlaces | Links | Ссылки |
| My notes | 我的笔记 | 我的筆記 | メモ | 내 메모 | Mes notes | Meine Notizen | Note personali | Mis notas | Minhas notas | Заметки |

Bullet labels (in `## 详情` block) per language:

| en | zh-CN | ja | ko | fr | de | it | es | pt | ru |
|---|---|---|---|---|---|---|---|---|---|
| Network | 平台 | 配信元 | 채널 | Chaîne | Sender | Rete | Cadena | Rede | Канал |
| Runtime | 片长 | 上映時間 | 상영 시간 | Durée | Laufzeit | Durata | Duración | Duração | Длительность |
| Episodes aired | 集数 | エピソード数 | 회차 | Épisodes diffusés | Folgen | Episodi | Episodios | Episódios | Эпизодов |
| Genres | 类型 | ジャンル | 장르 | Genres | Genres | Generi | Géneros | Gêneros | Жанры |
| Rating | 评分 | 評価 | 평점 | Note | Bewertung | Voto | Calificación | Avaliação | Рейтинг |
| Certification | 分级 | 視聴年齢 | 시청 등급 | Classification | Altersfreigabe | Classificazione | Clasificación | Classificação | Возрастной рейтинг |
| Status | 状态 | ステータス | 상태 | Statut | Status | Stato | Estado | Status | Статус |
| First aired | 首播 | 配信開始 | 첫 방영 | Première | Erstausstrahlung | Prima messa in onda | Estreno | Estreia | Премьера |
| Released | 上映 | 公開 | 개봉 | Sortie | Veröffentlicht | Uscita | Estreno | Lançamento | Релиз |

Trakt status labels:

| en | zh-CN | ja | ko | fr | de | it | es | pt | ru |
|---|---|---|---|---|---|---|---|---|---|
| Want to watch | 想看 | 観たい | 보고 싶음 | À voir | Möchte sehen | Da vedere | Quiero ver | Quero ver | Хочу посмотреть |
| Watched | 看过 | 視聴済み | 시청함 | Vu | Gesehen | Visto | Visto | Visto | Просмотрено |
| Favorite | 收藏 | お気に入り | 즐겨찾기 | Favori | Favorit | Preferito | Favorito | Favorito | Избранное |
| My rating | 我的评分 | 自分の評価 | 내 평점 | Ma note | Meine Bewertung | Il mio voto | Mi calificación | Minha avaliação | Моя оценка |

### Dropdown filter logic

Add to `src/settings.ts`:

```typescript
/**
 * [0.6.0] Languages we ship bundled body templates for. The template
 * language dropdown only lists these — any other code would silently
 * fall back to English, which confused users. See spec 0007.
 */
export const BUNDLED_TEMPLATE_LANGUAGES = [
  ["", "Default (English)"],
  ["zh-CN", "Chinese (Simplified, China)"],
  ["zh-TW", "Chinese (Traditional, Taiwan)"],
  ["ja-JP", "Japanese"],
  ["ko-KR", "Korean"],
  ["fr-FR", "French"],
  ["de-DE", "German"],
  ["it-IT", "Italian"],
  ["es-ES", "Spanish"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["ru-RU", "Russian"],
] as const;
```

The template-language `Setting` dropdown renders from
`BUNDLED_TEMPLATE_LANGUAGES` instead of `METADATA_LANGUAGE_PRESETS`.
Custom code option is **removed** (had no effect anyway).

Metadata-language dropdown keeps `METADATA_LANGUAGE_PRESETS` (15+
options + custom). They're now intentionally different surfaces.

### `getDefaultMovieTemplate` / `getDefaultShowTemplate` resolver

Update the existing helpers in `src/settings.ts`:

```typescript
export function getDefaultMovieTemplate(lang: string): string {
  switch ((lang || "").toLowerCase()) {
    case "zh-cn": return DEFAULT_MOVIE_TEMPLATE_ZH_CN;
    case "zh-tw":
    case "zh-hk": return DEFAULT_MOVIE_TEMPLATE_ZH_TW;
    case "ja-jp":
    case "ja":    return DEFAULT_MOVIE_TEMPLATE_JA;
    case "ko-kr":
    case "ko":    return DEFAULT_MOVIE_TEMPLATE_KO;
    case "fr-fr":
    case "fr":    return DEFAULT_MOVIE_TEMPLATE_FR;
    case "de-de":
    case "de":    return DEFAULT_MOVIE_TEMPLATE_DE;
    case "it-it":
    case "it":    return DEFAULT_MOVIE_TEMPLATE_IT;
    case "es-es":
    case "es-mx":
    case "es":    return DEFAULT_MOVIE_TEMPLATE_ES;
    case "pt-br":
    case "pt":    return DEFAULT_MOVIE_TEMPLATE_PT;
    case "ru-ru":
    case "ru":    return DEFAULT_MOVIE_TEMPLATE_RU;
    default:      return DEFAULT_MOVIE_TEMPLATE_EN;
  }
}
```

Same shape for `getDefaultShowTemplate`. Note we accept both
short codes (`ja`, `ko`) and locale codes (`ja-JP`, `ko-KR`) so
custom-mode users with bare language codes still resolve correctly.

### Translation quality

Each bundled template is a fresh translation — not machine output.
Style choices:

- **No bilingual labels** ("Director / 监督") — use the target
  language consistently
- **Local punctuation** — Japanese full-width punctuation, French
  spaced colons ("Genres : Drame, Crime"), etc.
- **Inline labels follow source convention** — `**Network**:` in en,
  `**配信元**：` in ja (full-width colon), `**Sender**:` in de
- **Headings use language-natural register** — `あらすじ` (ja
  "synopsis", everyday tone) not `要約` (formal "summary")

User can always Reset to default and bundled set is preserved as
ground truth.

## Edge cases

| # | Scenario | Behavior |
|---|---|---|
| 1 | User on 0.5.x with `templateLanguage="ja-JP"` (which silently used English) | After 0.6.0 upgrade, the same setting now produces the Japanese template on the next sync. **Important**: spec preserves the existing setting value — no migration needed |
| 2 | User on 0.5.x with `templateLanguage="custom"` + customMetadataLanguage | The dropdown drops "Custom" in 0.6.0. If the saved value is `"custom"`, settings UI shows blank (no option matches); next save normalizes to `""` (default-English). Customized template body content is preserved (we don't touch user-edited templates on language change) |
| 3 | User switches template language while their movie/show template body matches the OLD default verbatim | Existing behavior: auto-rewrite to new-language default. With 8 new languages bundled, this now actually does something different per language (instead of all falling back to English) |
| 4 | User switches template language while their template body has been customized | Existing behavior: preserve user's customized template. Unchanged here |
| 5 | Setting `templateLanguage` to a 2-letter form like `ja` (e.g. via data.json hand-edit) | Resolved by the case fall-through to the full-locale match |
| 6 | Daily Notes (spec 0006) verb translations | Same 11-language coverage |

## Tests

Adds to `tests/i18n.smoke.ts`:

- `getDefaultMovieTemplate("ja-JP")` returns the Japanese template (not English)
- Same for `ko-KR`, `fr-FR`, `de-DE`, `it-IT`, `es-ES`, `pt-BR`, `ru-RU`
- `getDefaultMovieTemplate("ja")` (short code) also returns Japanese
- `getDefaultMovieTemplate("tr-TR")` (unsupported) falls back to English
- Same suite for `getDefaultShowTemplate`
- Each new bundled template contains the expected localized section
  headings (catches accidental copy-paste-from-English regressions)

Estimated: 30+ new test cases (10 langs × 3 assertions each).

## Migration

No data migration needed. `templateLanguage` field stays as-is in
data.json; the resolver function gains 8 new branches but existing
values keep working.

If a user had `templateLanguage="custom"`, the dropdown won't show
it. Their **saved value remains in data.json**, but the next time
they open settings, the dropdown will be empty (no match), and on
next save it normalizes to default. Their actual template body
(stored separately as `movieNoteTemplate`/`showNoteTemplate`) is
unaffected.

## Implementation surface

| File | Change |
|---|---|
| `src/settings.ts` | 16 new template constants; `BUNDLED_TEMPLATE_LANGUAGES` constant; resolver updates; dropdown filter in `TraktrSettingTab` |
| `src/i18n.ts` | New `loc.templateLanguage.*` translation help if needed |
| `tests/i18n.smoke.ts` | ~30 new cases verifying resolver coverage |
| `docs/CHANGELOG.md` | 0.6.0 entry mentions both spec 0005 and 0007 |
| `docs/MANUAL.md` + i18n variants | Mention 11-language template coverage (was "3-language") |

Estimated raw size: 16 template constants × ~30 lines each = ~500
lines of translated markdown. Plus ~50 lines of resolver code +
filter logic. Net ~550 LOC.

## Future work

- More bundled languages on demand (Arabic, Hindi, Indonesian, etc.)
- Translate plugin UI strings (`uiLanguage`) into the same 11 langs
- Translate MANUAL.md / SETUP.md into the same 11 langs (currently
  4-language coverage for docs)
