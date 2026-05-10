import { requestUrl } from "obsidian";
import type { PosterSize } from "./settings";

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

export interface TmdbTranslation {
  title: string;
  overview: string;
  tagline: string;
  genres: string[];
}

export interface TmdbMetadata {
  poster_url: string;
  translation: TmdbTranslation | null;
}

/**
 * Shape of a single entry inside the `translations.translations[]` array
 * returned by `?append_to_response=translations`. The `data` block is what we
 * actually consume — fields are sometimes empty strings when a translation
 * row has been moderated as "no value yet" on TMDB.
 */
interface TmdbTranslationEntry {
  iso_639_1: string;
  iso_3166_1: string;
  data: {
    title?: string;
    name?: string;
    overview?: string;
    tagline?: string;
  };
}

interface TmdbMovieResponse {
  poster_path: string | null;
  original_title?: string;
  original_name?: string;
  title?: string;
  name?: string;
  overview?: string;
  tagline?: string;
  genres?: { name?: string }[];
  translations?: { translations: TmdbTranslationEntry[] };
}

export async function fetchMovieMetadata(
  tmdbId: number,
  apiKey: string,
  size: PosterSize,
  language: string,
): Promise<TmdbMetadata> {
  return fetchTmdbMetadata("movie", tmdbId, apiKey, size, language);
}

export async function fetchTvMetadata(
  tmdbId: number,
  apiKey: string,
  size: PosterSize,
  language: string,
): Promise<TmdbMetadata> {
  return fetchTmdbMetadata("tv", tmdbId, apiKey, size, language);
}

/**
 * Fetch poster URL + (when language is non-empty) localized title / overview
 * / tagline / genres for a movie or TV show by its TMDB ID.
 *
 * Implementation notes (resolves two known TMDB API quirks the user reported):
 *
 * 1. **Title can fall back to English even when a Chinese page exists.** TMDB
 *    moderators sometimes lock the `title` field on a `zh-CN` translation row
 *    to blank — typically for movies without an official mainland release.
 *    The API does NOT auto-fall-back to other Chinese variants (zh-TW /
 *    zh-HK / zh-SG) when this happens; it returns the English original. The
 *    website *does* fall back, which is why you see Chinese titles there but
 *    English titles in the API.
 *
 *    Fix: append `translations` to the response and walk the
 *    `translations.translations[]` array client-side. Pick the best non-empty
 *    variant in the user's language family (e.g. for `zh-CN` we try CN → TW
 *    → HK → SG → any other zh entry).
 *
 * 2. **Poster path can be null when language doesn't have a localized
 *    poster.** Same root cause as #1 — the API does not transparently fall
 *    back to the default poster.
 *
 *    Fix: when `poster_path` comes back null AND a language was specified,
 *    retry the request without the `language` parameter. That second call
 *    only fires for items missing a localized poster — most items don't pay
 *    this cost.
 */
async function fetchTmdbMetadata(
  mediaType: "movie" | "tv",
  tmdbId: number,
  apiKey: string,
  size: PosterSize,
  language: string,
): Promise<TmdbMetadata> {
  try {
    const params = new URLSearchParams({ api_key: apiKey });
    if (language) {
      params.set("language", language);
      params.set("append_to_response", "translations");
    }
    const resp = await requestUrl({
      url: `${TMDB_BASE}/${mediaType}/${tmdbId}?${params.toString()}`,
      method: "GET",
      headers: { "Content-Type": "application/json" },
      throw: false,
    });

    if (resp.status !== 200) {
      console.warn(
        `TMDB lookup failed for ${mediaType}/${tmdbId}: ${resp.status}`,
      );
      return { poster_url: "", translation: null };
    }

    const data = resp.json as TmdbMovieResponse;
    let posterPath = data.poster_path;

    // Poster fallback: if the language-specific request returned null and we
    // had a language set, fetch the default poster (no language filter). One
    // extra call, but only for items where the localized request didn't have
    // a poster — for most items this branch never runs.
    if (language && !posterPath) {
      try {
        const fbParams = new URLSearchParams({ api_key: apiKey });
        const fbResp = await requestUrl({
          url: `${TMDB_BASE}/${mediaType}/${tmdbId}?${fbParams.toString()}`,
          method: "GET",
          headers: { "Content-Type": "application/json" },
          throw: false,
        });
        if (fbResp.status === 200) {
          const fbData = fbResp.json as TmdbMovieResponse;
          posterPath = fbData.poster_path;
        }
      } catch (e) {
        console.warn(
          `TMDB poster fallback error for ${mediaType}/${tmdbId}:`,
          e,
        );
      }
    }

    const poster_url = posterPath
      ? `${TMDB_IMAGE_BASE}/${size}${posterPath}`
      : "";

    if (!language) {
      return { poster_url, translation: null };
    }

    const translation = pickBestTranslation(data, language, mediaType);
    return { poster_url, translation };
  } catch (e) {
    console.warn(`TMDB lookup error for ${mediaType}/${tmdbId}:`, e);
    return { poster_url: "", translation: null };
  }
}

/**
 * Pick the best-fit translation for a movie or TV item given the user's
 * requested BCP 47 code. Strategy:
 *
 * 1. If the main response already has a non-empty title that DIFFERS from
 *    the original title (and the user's language is not the original's
 *    language), trust it — TMDB returned a real localized title.
 *    We still merge in the translations array for any field the main
 *    response has empty (overview/tagline can be selectively blank).
 *
 * 2. Otherwise (main response title fell back to English), search
 *    `translations.translations[]` for the best variant in the user's
 *    language family. For `zh-CN` we walk CN → TW → HK → SG → any zh.
 *    For other languages, exact country first, then any country-less or
 *    other-country entry.
 *
 * 3. If nothing matches, return null — caller will keep originals.
 *
 * NOTE: the translations array's per-locale `data` block does NOT include
 * genres. So genre localization comes from the main response only. If the
 * main response is fully English (zh-CN locked blank), genres will also be
 * English. Acceptable trade-off — genre names are short and the user can
 * read both languages, while title is the user's primary concern.
 */
export function pickBestTranslation(
  data: TmdbMovieResponse,
  language: string,
  mediaType: "movie" | "tv",
): TmdbTranslation | null {
  const titleField = mediaType === "movie" ? data.title : data.name;
  const originalField =
    mediaType === "movie" ? data.original_title : data.original_name;
  const mainTitle = (titleField || "").trim();
  const mainOriginal = (originalField || "").trim();
  const mainOverview = (data.overview || "").trim();
  const mainTagline = (data.tagline || "").trim();
  const mainGenres = (data.genres || [])
    .map((g) => (g.name || "").trim())
    .filter((n) => n.length > 0);

  // The main response is "fully localized" when title is non-empty AND
  // differs from the original title — that's a strong signal that TMDB had a
  // real translation registered for the requested language.
  const mainLooksLocalized =
    mainTitle.length > 0 && mainTitle !== mainOriginal;

  // Build a candidate list from the translations array, ordered by best fit.
  const candidates = orderCandidates(
    data.translations?.translations || [],
    language,
  );

  const fromCandidate = (
    field: "title" | "overview" | "tagline",
  ): string => {
    for (const c of candidates) {
      const value =
        field === "title"
          ? mediaType === "movie"
            ? c.data.title
            : c.data.name
          : field === "overview"
            ? c.data.overview
            : c.data.tagline;
      if (value && value.trim().length > 0) return value.trim();
    }
    return "";
  };

  if (mainLooksLocalized) {
    // Trust the main response, fall back to translations only where main is
    // empty (TMDB sometimes has title localized but overview blank, etc.).
    return {
      title: mainTitle,
      overview: mainOverview || fromCandidate("overview"),
      tagline: mainTagline || fromCandidate("tagline"),
      genres: mainGenres,
    };
  }

  // Main response is the English fallback. Use translations array exclusively
  // for title/overview/tagline; genres still come from main (English).
  const candidateTitle = fromCandidate("title");
  const candidateOverview = fromCandidate("overview");
  const candidateTagline = fromCandidate("tagline");

  if (
    candidateTitle.length === 0 &&
    candidateOverview.length === 0 &&
    candidateTagline.length === 0
  ) {
    // No usable translation in the user's language family.
    return null;
  }

  return {
    title: candidateTitle,
    overview: candidateOverview,
    tagline: candidateTagline,
    genres: mainGenres,
  };
}

/**
 * Order the translations array by how well each entry matches the requested
 * BCP 47 code. Same-language entries come first; within them, exact-country
 * match wins, then a language-specific fallback chain (defined for `zh`),
 * then any same-language entry, then nothing else.
 */
function orderCandidates(
  all: ReadonlyArray<TmdbTranslationEntry>,
  language: string,
): TmdbTranslationEntry[] {
  const parts = language.split("-");
  const langCode = (parts[0] || "").toLowerCase();
  const country = (parts[1] || "").toUpperCase();
  if (!langCode) return [];

  const sameLang = all.filter(
    (t) => (t.iso_639_1 || "").toLowerCase() === langCode,
  );
  if (sameLang.length === 0) return [];

  // Country fallback chain — gives deterministic ordering within a language
  // family. For `zh` we use the well-known CN → TW → HK → SG progression
  // (Simplified mainland → Traditional Taiwan → Traditional HK → Simplified
  // Singapore). For other languages we have no strong intuition, so we
  // fall through to "exact country first, then anything else".
  const familyFallback: Record<string, string[]> = {
    zh: ["CN", "TW", "HK", "SG"],
    en: ["US", "GB", "AU", "CA"],
    es: ["ES", "MX", "AR"],
    pt: ["BR", "PT"],
    fr: ["FR", "CA"],
  };
  const ordered: string[] = [];
  if (country) ordered.push(country);
  for (const fb of familyFallback[langCode] || []) {
    if (!ordered.includes(fb)) ordered.push(fb);
  }

  const ranked: TmdbTranslationEntry[] = [];
  // First: country-priority order.
  for (const c of ordered) {
    const match = sameLang.find((t) => t.iso_3166_1 === c);
    if (match) ranked.push(match);
  }
  // Then: any other same-language entries we haven't ranked yet, in their
  // original order from the API.
  for (const t of sameLang) {
    if (!ranked.includes(t)) ranked.push(t);
  }
  return ranked;
}
