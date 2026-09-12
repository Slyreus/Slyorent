import { canonicalMediaTitle, type MediaEpisode } from "./media-library.ts";
import { canResume, type WatchRecord } from "./media-playback.ts";
import type { LibraryPreferences } from "../electron/library-preferences-schema.mjs";

export type Category = "all" | "series" | "movie" | "audio";
export type CatalogFilters = { query: string; category: Category; watch: "all" | "continue" | "unwatched" | "completed"; availability: "all" | "ready" | "pending"; favoritesOnly: boolean; torrent: string; season: string };
export const EMPTY_FILTERS: CatalogFilters = { query: "", category: "all", watch: "all", availability: "all", favoritesOnly: false, torrent: "", season: "" };
export type CatalogGroup = { key: string; title: string; category: Category; episodes: MediaEpisode[]; bytes: number; addedAt: number; watchedAt: number; ready: number; watched: number; seasons: number[]; torrents: number };
export type WatchHistory = Record<string, WatchRecord>;
const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });
export const normalizeSearch = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const categoryOf = (episode: MediaEpisode): Exclude<Category, "all"> => episode.kind === "audio" ? "audio" : episode.episodeNumber !== null || episode.seasonNumber !== null ? "series" : "movie";
export const titleOf = (episode: MediaEpisode) => categoryOf(episode) === "movie" ? episode.episodeTitle : episode.seriesTitle;
export function titleKey(episode: MediaEpisode) {
  const title = canonicalMediaTitle(titleOf(episode)).slice(0, 350);
  return `${categoryOf(episode)}:${title || "sans titre"}`;
}
export function matchesSearch(episode: MediaEpisode, query: string) {
  const season = episode.seasonNumber, number = episode.episodeNumber;
  let exactMatch = true;
  const remaining = normalizeSearch(query)
    .replace(/\bs(?:aison|eason)?\s*(\d{1,2})(?:\s*e(?:pisode|p)?\s*(\d{1,3}))?\b/gu, (_match, s: string, e?: string) => {
      if (season !== Number(s) || (e !== undefined && number !== Number(e))) exactMatch = false;
      return " ";
    })
    .replace(/\b(?:episode|ep|e)\s*(\d{1,3})\b/gu, (_match, e: string) => {
      if (number !== Number(e)) exactMatch = false;
      return " ";
    });
  if (!exactMatch) return false;
  const terms = [titleOf(episode), episode.episodeTitle, episode.torrentName, episode.fileName, episode.extension, episode.kind, categoryOf(episode),
    season !== null ? `saison ${season} season ${season} s${season} s${String(season).padStart(2, "0")}` : "hors saison",
    number !== null ? `episode ${number} ep ${number} e${number} e${String(number).padStart(2, "0")}` : "film",
    season !== null && number !== null ? `s${season}e${number} s${String(season).padStart(2, "0")}e${String(number).padStart(2, "0")}` : "",
  ];
  const haystack = normalizeSearch(terms.join(" "));
  return remaining.trim().split(/\s+/u).every((term) => haystack.includes(term));
}
export function filterCatalog(episodes: readonly MediaEpisode[], filters: CatalogFilters, history: WatchHistory, favorites: readonly string[]) {
  const favoriteSet = new Set(favorites);
  return episodes.filter((episode) => {
    if (filters.category !== "all" && categoryOf(episode) !== filters.category) return false;
    if (filters.torrent && String(episode.torrentId) !== filters.torrent) return false;
    if (filters.season && String(episode.seasonNumber) !== filters.season) return false;
    if (filters.favoritesOnly && !favoriteSet.has(titleKey(episode))) return false;
    if (filters.availability === "ready" && !episode.playable || filters.availability === "pending" && episode.playable) return false;
    const record = history[episode.watchKey];
    if (filters.watch === "continue" && !canResume(record) || filters.watch === "completed" && !record?.completed || filters.watch === "unwatched" && (record?.completed || canResume(record))) return false;
    return matchesSearch(episode, filters.query);
  });
}
export function naturalOrder(a: MediaEpisode, b: MediaEpisode) {
  return collator.compare(canonicalMediaTitle(titleOf(a)), canonicalMediaTitle(titleOf(b))) || (a.seasonNumber ?? Infinity) - (b.seasonNumber ?? Infinity)
    || (a.episodeNumber ?? Infinity) - (b.episodeNumber ?? Infinity) || collator.compare(a.episodeTitle, b.episodeTitle) || collator.compare(a.fileName, b.fileName) || a.torrentId - b.torrentId || a.fileIndex - b.fileIndex;
}
export function sortCatalog(episodes: readonly MediaEpisode[], preferences: LibraryPreferences, history: WatchHistory) {
  const direction = preferences.descending ? -1 : 1;
  return [...episodes].sort((a, b) => {
    let delta = 0;
    if (preferences.sort === "added") delta = (a.addedAt || 0) - (b.addedAt || 0);
    if (preferences.sort === "watched") delta = (history[a.watchKey]?.updatedAt || 0) - (history[b.watchKey]?.updatedAt || 0);
    if (preferences.sort === "size") delta = a.length - b.length;
    return delta * direction || naturalOrder(a, b) * (preferences.sort === "title" ? direction : 1);
  });
}
export function groupCatalog(episodes: readonly MediaEpisode[], mode: "title" | "torrent", preferences: LibraryPreferences, history: WatchHistory): CatalogGroup[] {
  const groups = new Map<string, CatalogGroup>();
  for (const episode of episodes) {
    const key = mode === "title" ? titleKey(episode) : `torrent:${episode.torrentId}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, title: mode === "title" ? titleOf(episode) : episode.torrentName, category: categoryOf(episode), episodes: [], bytes: 0, addedAt: 0, watchedAt: 0, ready: 0, watched: 0, seasons: [], torrents: 0 };
      groups.set(key, group);
    }
    if (categoryOf(episode) !== group.category) group.category = "all";
    group.episodes.push(episode); group.bytes += episode.length;
    group.addedAt = Math.max(group.addedAt, episode.addedAt || 0);
    group.watchedAt = Math.max(group.watchedAt, history[episode.watchKey]?.updatedAt || 0);
    if (episode.playable) group.ready++;
    if (history[episode.watchKey]?.completed) group.watched++;
  }
  for (const group of groups.values()) {
    group.episodes.sort(naturalOrder);
    group.seasons = [...new Set(group.episodes.map((item) => item.seasonNumber).filter((value) => value !== null))].sort((a, b) => a - b);
    group.torrents = new Set(group.episodes.map((item) => item.torrentId)).size;
  }
  return [...groups.values()].sort((a, b) => {
    const delta = preferences.sort === "title" ? collator.compare(a.title, b.title) : preferences.sort === "added" ? a.addedAt - b.addedAt : preferences.sort === "watched" ? a.watchedAt - b.watchedAt : a.bytes - b.bytes;
    return delta * (preferences.descending ? -1 : 1) || collator.compare(a.title, b.title) || collator.compare(a.key, b.key);
  });
}
export function nextToWatch(episodes: readonly MediaEpisode[], history: WatchHistory) {
  const ready = episodes.filter((item) => item.playable).sort(naturalOrder);
  const identity = (item: MediaEpisode) => item.episodeNumber !== null ? `${titleKey(item)}:${item.seasonNumber}:${item.episodeNumber}` : item.watchKey;
  const completed = new Set(episodes.filter((item) => history[item.watchKey]?.completed).map(identity));
  const unwatched = ready.filter((item) => !completed.has(identity(item)));
  const resumed = unwatched.filter((item) => canResume(history[item.watchKey])).sort((a, b) => history[b.watchKey].updatedAt - history[a.watchKey].updatedAt);
  return resumed[0] || unwatched[0] || ready[0];
}
export function formatLibrarySize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 o";
  const unit = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${new Intl.NumberFormat("fr", { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit)} ${["o", "Ko", "Mo", "Go", "To"][unit]}`;
}
