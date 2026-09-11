import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMediaLibrary,
  buildPlaybackQueue,
  flattenPlayableSeries,
  parseMediaIdentity,
} from "../lib/media-library.ts";

function mediaFile(index, name, overrides = {}) {
  const length = overrides.length ?? 1_000;
  return {
    index,
    name,
    length,
    bytesCompleted: overrides.bytesCompleted ?? length,
    wanted: overrides.wanted ?? true,
    media: overrides.media ?? true,
    scanStatus: overrides.scanStatus ?? "clean",
  };
}

function torrent(id, name, files, overrides = {}) {
  return {
    id,
    name,
    percentDone: overrides.percentDone ?? 1,
    uploadRatio: overrides.uploadRatio ?? 0,
    files,
  };
}

test("analyse S01E02 et retire les marqueurs techniques du titre affiché", () => {
  assert.deepEqual(
    parseMediaIdentity(
      "Arcane.S01E02.Some.Mysteries.1080p.WEB-DL.x265.mkv",
      "Arcane.S01.MULTI.1080p",
    ),
    {
      seriesTitle: "Arcane",
      seasonNumber: 1,
      episodeNumber: 2,
      episodeTitle: "Some Mysteries",
      extension: "mkv",
      kind: "video",
    },
  );
});

test("analyse la convention 1x02 sans confondre saison et épisode", () => {
  assert.deepEqual(
    parseMediaIdentity(
      "Le.Bureau.Des.Legendes.1x02.La.Route.mp4",
      "Le Bureau des Legendes",
    ),
    {
      seriesTitle: "Le Bureau Des Legendes",
      seasonNumber: 1,
      episodeNumber: 2,
      episodeTitle: "La Route",
      extension: "mp4",
      kind: "video",
    },
  );
});

test("déduit la saison du chemin Saison et l'épisode du nom de fichier", () => {
  const parsed = parseMediaIdentity(
    "The Show/Saison 03/Episode 07 - Finale.mkv",
    "The.Show.Saison.03.1080p",
  );
  assert.equal(parsed.seriesTitle, "The Show");
  assert.equal(parsed.seasonNumber, 3);
  assert.equal(parsed.episodeNumber, 7);
  assert.equal(parsed.episodeTitle, "Finale");
});

test("classe les formats audio pris en charge et conserve les autres médias en vidéo", () => {
  for (const extension of ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac"]) {
    const parsed = parseMediaIdentity(`Album/01 - Intro.${extension.toUpperCase()}`, "Album");
    assert.equal(parsed.kind, "audio", extension);
    assert.equal(parsed.extension, extension, extension);
  }
  assert.equal(parseMediaIdentity("Film.webm", "Film").kind, "video");
  assert.equal(parseMediaIdentity("Film.mkv", "Film").kind, "video");
});

test("regroupe sans fusionner les torrents, puis les séries et saisons", () => {
  const library = buildMediaLibrary([
    torrent(20, "Anthologie", [
      mediaFile(0, "Alpha.S01E01.Pilote.mkv"),
      mediaFile(1, "Alpha.S02E01.Retour.mkv"),
      mediaFile(2, "Beta.S01E01.Depart.mkv"),
    ]),
    torrent(21, "Anthologie - Copie locale", [
      mediaFile(0, "Alpha.S01E02.Suite.mkv"),
    ]),
  ]);

  assert.equal(library.length, 2);
  assert.deepEqual(library[0].series.map((series) => series.title), ["Alpha", "Beta"]);
  assert.deepEqual(library[0].series[0].seasons.map((season) => season.label), ["Saison 1", "Saison 2"]);
  assert.equal(library[1].torrentId, 21);
  assert.equal(library[1].series[0].seasons[0].episodes[0].episodeNumber, 2);
});

test("ordonne torrents, séries, saisons et épisodes de façon déterministe", () => {
  const library = buildMediaLibrary([
    torrent(2, "Zulu", [mediaFile(0, "Zulu.S01E01.Pilote.mkv")]),
    torrent(1, "Alpha", [
      mediaFile(0, "Serie.Zeta.S10E02.Deux.mkv"),
      mediaFile(1, "Serie.Zeta.S02E10.Dix.mkv"),
      mediaFile(2, "Serie.Zeta.S02E02.Deux.mkv"),
      mediaFile(3, "Serie.Alpha.S01E01.Pilote.mkv"),
    ]),
  ]);

  assert.deepEqual(library.map((group) => group.torrentName), ["Alpha", "Zulu"]);
  assert.deepEqual(library[0].series.map((series) => series.title), ["Serie Alpha", "Serie Zeta"]);
  const zeta = library[0].series[1];
  assert.deepEqual(zeta.seasons.map((season) => season.seasonNumber), [2, 10]);
  assert.deepEqual(zeta.seasons[0].episodes.map((episode) => episode.episodeNumber), [2, 10]);
});

test("recherche sans tenir compte des accents et comprend saison, épisode, audio et torrent", () => {
  const torrents = [
    torrent(1, "Collection Mystère", [
      mediaFile(0, "Voyage.S01E01.Depart.mkv"),
      mediaFile(1, "Voyage.S02E03.L.Ete.mkv"),
      mediaFile(2, "Voyage.S02E10.Final.mkv"),
      mediaFile(3, "Voyage.Theme.flac"),
    ]),
  ];

  assert.equal(buildMediaLibrary(torrents, "été")[0].total, 1);
  assert.deepEqual(
    buildMediaLibrary(torrents, "saison 2")[0].series[0].seasons[0].episodes.map((episode) => episode.episodeNumber),
    [3, 10],
  );
  assert.equal(buildMediaLibrary(torrents, "episode 10")[0].total, 1);
  assert.equal(buildMediaLibrary(torrents, "audio")[0].series[0].seasons[0].episodes[0].kind, "audio");
  assert.equal(buildMediaLibrary(torrents, "collection mystere")[0].total, 4);
  assert.deepEqual(buildMediaLibrary(torrents, "introuvable"), []);
});

test("n'autorise que les fichiers complets, voulus, média et marqués clean", () => {
  const library = buildMediaLibrary([
    torrent(7, "Sécurité", [
      mediaFile(0, "Demo.S01E01.Propre.mkv"),
      mediaFile(1, "Demo.S01E02.Incomplet.mkv", { bytesCompleted: 999 }),
      mediaFile(2, "Demo.S01E03.NonAnalyse.mkv", { scanStatus: "not-scanned" }),
      mediaFile(3, "Demo.S01E04.Vide.mkv", { length: 0, bytesCompleted: 0 }),
      mediaFile(4, "Demo.S01E05.NonVoulu.mkv", { wanted: false }),
      mediaFile(5, "notes.txt", { media: false }),
    ], { uploadRatio: 1.25 }),
  ]);

  assert.equal(library[0].total, 4);
  assert.equal(library[0].playable, 1);
  const episodes = library[0].series[0].seasons[0].episodes;
  assert.deepEqual(episodes.map(({ completed, playable }) => ({ completed, playable })), [
    { completed: true, playable: true },
    { completed: false, playable: false },
    { completed: true, playable: false },
    { completed: false, playable: false },
  ]);
  assert.equal(episodes[0].uploadRatio, 1.25);
  assert.deepEqual(flattenPlayableSeries(library[0], library[0].series[0].key).map((episode) => episode.fileIndex), [0]);
  assert.deepEqual(flattenPlayableSeries(library[0], "clé-inconnue"), []);
});

test("retrouver le suivi par infohash même si le moteur change l'identifiant du torrent", () => {
  const original = { ...torrent(1, "Collection", [mediaFile(0, "Show.S01E01.mkv")]), hash: "a".repeat(40) };
  const restarted = { ...original, id: 17 };
  const left = buildMediaLibrary([original])[0].series[0].seasons[0].episodes[0];
  const right = buildMediaLibrary([restarted])[0].series[0].seasons[0].episodes[0];
  assert.equal(left.watchKey, right.watchKey);
  assert.notEqual(left.key, right.key);
});

test("ne pas afficher le groupe d'encodage comme titre d'épisode", () => {
  const parsed = parseMediaIdentity("Show.S01E02.MULTi.1080p.BluRay.x264-RELEASE.mkv", "Show.S01");
  assert.equal(parsed.episodeTitle, "Épisode 02");
  assert.equal(parseMediaIdentity("Show.S01E02.Le.voyage.1080p.WEB-DL.x264-RELEASE.mkv", "Show.S01").episodeTitle, "Le Voyage");
  assert.equal(parseMediaIdentity("Film (2022) VOSTFR 1080p WEB x264 AAC -RELEASE.mkv", "Film (2022) VOSTFR 1080p WEB x264 AAC -RELEASE.mkv").episodeTitle, "Film (2022)");
});

test("passer à la saison suivante dans un autre torrent sans lire les doublons", () => {
  const groups = buildMediaLibrary([
    torrent(1, "Show.S01", [mediaFile(0, "Show.S01E01.mkv"), mediaFile(1, "Show.S01E02.mkv")]),
    torrent(2, "Show.S02", [mediaFile(0, "Show.S02E01.mkv"), mediaFile(1, "Show.S02E02.mkv", { scanStatus: "not-scanned" })]),
    torrent(3, "Show.Copie", [mediaFile(0, "Show.S01E02.mkv")]),
  ]);
  const episodes = groups.flatMap((group) => group.series.flatMap((series) => series.seasons.flatMap((season) => season.episodes)));
  const current = episodes.find((episode) => episode.torrentId === 1 && episode.episodeNumber === 2);
  const queue = buildPlaybackQueue(episodes, current);
  assert.deepEqual(queue.map((episode) => episode.key), ["1:0", "1:1", "2:0"]);
  const duplicate = episodes.find((episode) => episode.torrentId === 3);
  assert.ok(buildPlaybackQueue(episodes, duplicate).some((episode) => episode.key === duplicate.key));
});
