import { requestUrl } from "obsidian";
import { computeCacheExpiry } from "./tmdb-api";
import type {
  OmdbPosterCache,
  OmdbPosterCacheEntry,
} from "./types";

const OMDB_BASE = "https://www.omdbapi.com/";
const OMDB_POSTER_CACHE_ENTRY_VERSION = 1 as const;
const OMDB_CACHE_TTL_DAYS = 90;
const TEST_IMDB_ID = "tt0133093";

interface OmdbTitleResponse {
  Response?: string;
  Error?: string;
  Poster?: string;
  imdbID?: string;
}

export type OmdbVerifyFailureReason =
  | "empty"
  | "unauthorized"
  | "limit"
  | "network";

export type OmdbVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason: OmdbVerifyFailureReason;
      detail?: string;
    };

function normalizeImdbId(imdbId: string): string {
  return imdbId.trim().toLowerCase();
}

function isUsableImdbId(imdbId: string): boolean {
  return /^tt\d{7,10}$/.test(imdbId);
}

function posterFromResponse(data: OmdbTitleResponse): string {
  const poster = (data.Poster || "").trim();
  return poster && poster.toUpperCase() !== "N/A" ? poster : "";
}

function classifyError(error: string): OmdbVerifyFailureReason {
  const normalized = error.toLowerCase();
  if (normalized.includes("limit")) return "limit";
  if (
    normalized.includes("api key") ||
    normalized.includes("unauthorized")
  ) {
    return "unauthorized";
  }
  return "network";
}

export function omdbPosterCacheKey(imdbId: string): string {
  return `omdb:${normalizeImdbId(imdbId)}`;
}

export function omdbPosterCacheEntryFreshness(
  entry: OmdbPosterCacheEntry | undefined,
  now = Date.now(),
): "missing" | "fresh" | "stale" {
  if (!entry) return "missing";
  if (entry.cache_version !== OMDB_POSTER_CACHE_ENTRY_VERSION) {
    return "missing";
  }
  return entry.expires_at > now ? "fresh" : "stale";
}

function buildTitleUrl(apiKey: string, imdbId: string): string {
  const params = new URLSearchParams({
    apikey: apiKey.trim(),
    i: imdbId,
    r: "json",
  });
  return `${OMDB_BASE}?${params.toString()}`;
}

export async function verifyOmdbApiKey(
  apiKey: string,
): Promise<OmdbVerifyResult> {
  const key = apiKey.trim();
  if (!key) return { ok: false, reason: "empty" };

  try {
    const response = await requestUrl({
      url: buildTitleUrl(key, TEST_IMDB_ID),
      method: "GET",
      headers: { "Content-Type": "application/json" },
      throw: false,
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "unauthorized", detail: `HTTP ${response.status}` };
    }
    if (response.status === 429) {
      return { ok: false, reason: "limit", detail: "HTTP 429" };
    }
    if (response.status !== 200) {
      return { ok: false, reason: "network", detail: `HTTP ${response.status}` };
    }

    const data = response.json as OmdbTitleResponse;
    if (data.Response === "True") return { ok: true };

    const detail = (data.Error || "OMDb rejected the request").trim();
    return { ok: false, reason: classifyError(detail), detail };
  } catch (error) {
    return {
      ok: false,
      reason: "network",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

interface PosterFetchResult {
  posterUrl: string;
  successful: boolean;
}

async function fetchPosterUncached(
  imdbId: string,
  apiKey: string,
): Promise<PosterFetchResult> {
  try {
    const response = await requestUrl({
      url: buildTitleUrl(apiKey, imdbId),
      method: "GET",
      headers: { "Content-Type": "application/json" },
      throw: false,
    });
    if (response.status !== 200) {
      console.warn(`OMDb poster lookup failed for ${imdbId}: ${response.status}`);
      return { posterUrl: "", successful: false };
    }

    const data = response.json as OmdbTitleResponse;
    if (data.Response !== "True") {
      console.warn(
        `OMDb poster lookup failed for ${imdbId}: ${data.Error || "unknown error"}`,
      );
      return { posterUrl: "", successful: false };
    }
    return { posterUrl: posterFromResponse(data), successful: true };
  } catch (error) {
    console.warn(`OMDb poster lookup error for ${imdbId}:`, error);
    return { posterUrl: "", successful: false };
  }
}

const inFlightRevalidations = new Set<string>();

export async function fetchOmdbPoster(
  imdbId: string,
  apiKey: string,
  cache: OmdbPosterCache,
): Promise<string> {
  const normalizedId = normalizeImdbId(imdbId);
  if (!apiKey.trim() || !isUsableImdbId(normalizedId)) return "";

  const cacheKey = omdbPosterCacheKey(normalizedId);
  const entry = cache[cacheKey];
  const freshness = omdbPosterCacheEntryFreshness(entry);
  if (freshness === "fresh" && entry) return entry.poster_url;

  if (freshness === "stale" && entry) {
    if (!inFlightRevalidations.has(cacheKey)) {
      inFlightRevalidations.add(cacheKey);
      void revalidatePoster(normalizedId, apiKey, cache, cacheKey);
    }
    return entry.poster_url;
  }

  const result = await fetchPosterUncached(normalizedId, apiKey);
  if (result.successful) {
    cache[cacheKey] = {
      cache_version: OMDB_POSTER_CACHE_ENTRY_VERSION,
      poster_url: result.posterUrl,
      cached_at: Date.now(),
      expires_at: computeCacheExpiry(OMDB_CACHE_TTL_DAYS),
    };
  }
  return result.posterUrl;
}

async function revalidatePoster(
  imdbId: string,
  apiKey: string,
  cache: OmdbPosterCache,
  cacheKey: string,
): Promise<void> {
  try {
    const result = await fetchPosterUncached(imdbId, apiKey);
    if (result.successful) {
      cache[cacheKey] = {
        cache_version: OMDB_POSTER_CACHE_ENTRY_VERSION,
        poster_url: result.posterUrl,
        cached_at: Date.now(),
        expires_at: computeCacheExpiry(OMDB_CACHE_TTL_DAYS),
      };
    }
  } finally {
    inFlightRevalidations.delete(cacheKey);
  }
}

export function clearOmdbPosterCache(cache: OmdbPosterCache): void {
  for (const key of Object.keys(cache)) delete cache[key];
}

export function omdbPosterCacheStats(cache: OmdbPosterCache): {
  entries: number;
  approxBytes: number;
} {
  const entries = Object.keys(cache).length;
  return { entries, approxBytes: entries * 160 };
}
