import assert from "node:assert/strict";
import test from "node:test";
import { buildMediaLibrary, buildPlaybackQueue } from "../lib/media-library.ts";
import { EMPTY_FILTERS, filterCatalog, formatLibrarySize, groupCatalog, matchesSearch, nextToWatch, sortCatalog, titleKey } from "../lib/library-catalog.ts";
import { LIBRARY_DEFAULTS } from "../electron/library-preferences-schema.mjs";

function torrent(id, name, files, extra = {}) {
  return { id, hash: String(id).padStart(40, "a"), name, addedAt: id * 1000, files: files.map((name, index) => ({ index, name, length: 1000 + id * 10, bytesCompleted: 10000, wanted: true, media: true, scanStatus: "clean" })), ...extra };
}
function flatten(torrents) { return buildMediaLibrary(torrents).flatMap((t) => t.series.flatMap((s) => s.seasons.flatMap((g) => g.episodes))); }
const episodes = flatten([
  torrent(1, "Rick.et.Morty.S01", ["Rick.et.Morty.S01E02.mkv", "Rick.et.Morty.S01E10.mkv", "Rick.et.Morty.S01E01.mkv"]),
  torrent(2, "Rick.and.Morty.S02", ["Rick.and.Morty.S02E03.Eté.spatial.mkv", "Rick.and.Morty.S02E13.mkv"]),
  torrent(3, "Rick.&.Morty.S01", ["Rick.&.Morty.S01E01.mkv"]),
  torrent(4, "Pack.cinema", ["Dune.1984.1080p.mkv", "Dune.2021.1080p.mkv", "Voyage.2.mp4", "Voyage.10.mp4"]),
  torrent(5, "Orbite.Album", ["01.Aurore.flac", "02.Voyage.flac"]),
]);
const prefs = (patch = {}) => ({ ...LIBRARY_DEFAULTS, ...patch });
const record = (position, completed = false, updatedAt = 1000) => ({ position, duration: 100, completed, updatedAt });

test("réunir les saisons et conserver les films distincts dans un pack", () => {
  const groups = groupCatalog(episodes, "title", prefs(), {});
  assert.equal(groups.length, 6);
  const series = groups.find((g) => g.category === "series");
  assert.equal(series.episodes.length, 6);
  assert.deepEqual(series.seasons, [1, 2]);
  assert.equal(series.torrents, 3);
  assert.deepEqual(series.episodes.map((e) => `${e.seasonNumber}:${e.episodeNumber}`), ["1:1", "1:1", "1:2", "1:10", "2:3", "2:13"]);
  assert.deepEqual(groups.filter((g) => g.category === "movie").map((g) => g.title), ["Dune 1984", "Dune 2021", "Voyage 2", "Voyage 10"]);
  assert.equal(groups.find((g) => g.category === "audio").episodes.length, 2);
  assert.equal(groupCatalog(episodes, "torrent", prefs(), {}).length, 5);
});

test("rechercher plusieurs mots et reconnaître exactement saison et épisode", () => {
  const episode = episodes.find((e) => e.seasonNumber === 2 && e.episodeNumber === 3);
  for (const query of ["morty ete", "Eté S02E03", "morty s2 e3", "saison 2 épisode 3", "season 2 ep 3", "s2e03", "mkv spatial"]) assert.equal(matchesSearch(episode, query), true, query);
  for (const query of ["saison 3", "saison 1 episode 3", "S02E13", "e13", "E30", "ete disparu"]) assert.equal(matchesSearch(episode, query), false, query);
  assert.equal(filterCatalog(episodes, { ...EMPTY_FILTERS, query: "saison 2" }, {}, []).length, 2);
  assert.equal(matchesSearch(episode, ""), true);
});

test("combiner favoris, disponibilité, torrent, saison et suivi sans ouvrir de fichier non validé", () => {
  const series = episodes.filter((e) => e.seasonNumber === 2);
  const fixture = [series[0], { ...series[1], playable: false, scanStatus: "not-scanned" }];
  const history = { [series[0].watchKey]: record(30) };
  const filters = { ...EMPTY_FILTERS, category: "series", torrent: "2", season: "2", favoritesOnly: true, watch: "continue", availability: "ready", query: "spatial" };
  assert.deepEqual(filterCatalog(fixture, filters, history, [titleKey(series[0])]), [series[0]]);
  assert.equal(filterCatalog(fixture, filters, history, []).length, 0);
  assert.equal(filterCatalog(fixture, { ...EMPTY_FILTERS, availability: "pending", watch: "unwatched" }, history, []).length, 1);
  assert.equal(filterCatalog(fixture, { ...EMPTY_FILTERS, watch: "completed" }, history, []).length, 0);
  assert.equal(nextToWatch([fixture[1]], {}), undefined);
});

test("trier sans modifier la liste source et agréger les dates réelles", () => {
  const original = episodes.map((e) => e.key);
  assert.equal(sortCatalog(episodes, prefs({ sort: "added", descending: true }), {})[0].torrentId, 5);
  assert.equal(sortCatalog(episodes, prefs({ sort: "size", descending: false }), {})[0].torrentId, 1);
  const history = { [episodes[0].watchKey]: record(20, false, 9000) };
  assert.equal(sortCatalog(episodes, prefs({ sort: "watched", descending: true }), history)[0].watchKey, episodes[0].watchKey);
  assert.equal(groupCatalog(episodes, "title", prefs({ sort: "watched", descending: true }), history)[0].episodes.some((e) => e.watchKey === episodes[0].watchKey), true);
  assert.equal(groupCatalog(episodes, "title", prefs({ sort: "added", descending: true }), {})[0].category, "audio");
  assert.deepEqual(episodes.map((e) => e.key), original);
});

test("reprendre le bon épisode et ignorer une copie d'un épisode déjà vu", () => {
  const series = episodes.filter((e) => e.episodeNumber !== null);
  const first = series.find((e) => e.torrentId === 1 && e.episodeNumber === 1);
  const second = series.find((e) => e.episodeNumber === 2);
  const history = { [first.watchKey]: record(100, true) };
  assert.equal(nextToWatch(series, history).key, second.key);
  const later = series.find((e) => e.seasonNumber === 2 && e.episodeNumber === 3);
  history[later.watchKey] = record(15, false, 4000);
  assert.equal(nextToWatch(series, history).key, later.key);
  const queue = buildPlaybackQueue(series, first);
  assert.deepEqual(queue.map((e) => `${e.seasonNumber}:${e.episodeNumber}`), ["1:1", "1:2", "1:10", "2:3", "2:13"]);
});

test("garder des identifiants stables et des unités lisibles", () => {
  assert.equal(titleKey(episodes.find((e) => e.torrentId === 1)), titleKey(episodes.find((e) => e.torrentId === 3)));
  assert.equal(formatLibrarySize(1024 ** 3), "1 Go");
  assert.equal(formatLibrarySize(NaN), "0 o");
  assert.equal(formatLibrarySize(-10), "0 o");
  assert.equal(groupCatalog([], "title", prefs(), {}).length, 0);
});
