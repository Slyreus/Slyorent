export type MediaFileInput = {
  index: number;
  name: string;
  length: number;
  bytesCompleted: number;
  wanted: boolean;
  media: boolean;
  scanStatus?: string;
};

export type MediaTorrentInput = {
  addedAt?: number;
  id: number;
  hash?: string;
  name: string;
  status?: string;
  percentDone?: number;
  uploadRatio?: number;
  files: MediaFileInput[];
};

export type MediaKind = "audio" | "video";

export type ParsedMediaIdentity = {
  seriesTitle: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string;
  extension: string;
  kind: MediaKind;
};

export type MediaEpisode = ParsedMediaIdentity & {
  addedAt?: number;
  key: string;
  watchKey: string;
  torrentId: number;
  torrentName: string;
  fileIndex: number;
  fileName: string;
  length: number;
  completed: boolean;
  scanStatus: string;
  playable: boolean;
  uploadRatio: number;
};

export type MediaSeasonGroup = {
  key: string;
  label: string;
  seasonNumber: number | null;
  episodes: MediaEpisode[];
};

export type MediaSeriesGroup = {
  key: string;
  title: string;
  seasons: MediaSeasonGroup[];
};

export type TorrentMediaGroup = {
  key: string;
  torrentId: number;
  torrentName: string;
  total: number;
  completed: number;
  playable: number;
  status: string;
  percentDone: number;
  series: MediaSeriesGroup[];
};

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac"]);
const RELEASE_TOKENS = /\b(?:2160p|1080p|720p|576p|480p|uhd|bluray|b[rd]rip|web[ ._-]?dl|webrip|hdtv|remux|hdr10?|dolby[ ._-]?vision|dv|x26[45]|h[ ._-]?26[45]|hevc|av1|aac|ac3|eac3|dts(?:hd)?|atmos|multi|vff|vfq|truefrench|french|english|subfrench|proper|repack|limited)\b/giu;

function displayText(value: string) {
  const technicalSuffix = /\b(?:2160p|1080p|720p|576p|480p|multi|vff|vfq|vostfr|truefrench|bluray|b[rd]rip|web[ ._-]?dl|webrip|hdtv|remux|x26[45]|h[ ._-]?26[45]|hevc|aac|e?ac3|dts(?:hd)?|truehd)\b/iu.exec(value);
  if (technicalSuffix) value = value.slice(0, technicalSuffix.index);
  return value
    .replace(/[._]+/g, " ")
    .replace(/[-–—]+/g, " ")
    .replace(RELEASE_TOKENS, " ")
    .replace(/\[[^\]]*\]|\([^)]*(?:rip|codec|audio|multi|vff|vfq|french)[^)]*\)/giu, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase("fr"));
}

function basename(value: string) {
  return value.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? value;
}

function withoutExtension(value: string) {
  return value.replace(/\.[a-z0-9]{2,5}$/iu, "");
}

function extensionOf(value: string) {
  return /\.([a-z0-9]{2,5})$/iu.exec(value)?.[1]?.toLowerCase() ?? "";
}

function safeNumber(value?: string) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function fallbackSeries(torrentName: string, fileStem: string) {
  const torrent = displayText(withoutExtension(basename(torrentName))
    .replace(/\bS(?:aison|eason)?[ ._-]*\d{1,2}\b.*$/iu, "")
    .replace(/\b\d{1,2}x\d{1,3}\b.*$/iu, ""));
  return torrent || displayText(fileStem) || "Média sans titre";
}

/** Parse les conventions S01E02, 1x02, Saison 1 Épisode 2 et les dossiers de saison. */
export function parseMediaIdentity(fileName: string, torrentName: string): ParsedMediaIdentity {
  const base = basename(fileName);
  const extension = extensionOf(base);
  const stem = withoutExtension(base);
  const pathText = fileName.replace(/\\/g, "/");
  const normalized = stem.replace(/[._]+/g, " ").replace(/\s{2,}/g, " ").trim();
  const pathSeason = /(?:^|[/\s._-])(?:s(?:aison|eason)?)[ ._-]*(\d{1,2})(?:[/\s._-]|$)/iu.exec(pathText)?.[1];

  const patterns = [
    /^(.*?)(?:^|[\s._-])S(\d{1,2})[\s._-]*E(\d{1,3})(?:[\s._-]+(.*))?$/iu,
    /^(.*?)(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?:[\s._-]+(.*))?$/iu,
    /^(.*?)(?:saison|season)[\s._-]*(\d{1,2}).*?(?:épisode|episode|ep)[\s._-]*(\d{1,3})(?:[\s._-]+(.*))?$/iu,
  ];

  let match: RegExpExecArray | null = null;
  for (const pattern of patterns) {
    match = pattern.exec(normalized);
    if (match) break;
  }

  let seriesTitle: string;
  let seasonNumber: number | null;
  let episodeNumber: number | null;
  let episodeTitle: string;

  if (match) {
    seriesTitle = displayText(match[1]) || fallbackSeries(torrentName, stem);
    seasonNumber = safeNumber(match[2]);
    episodeNumber = safeNumber(match[3]);
    episodeTitle = displayText(match[4] ?? "") || `Épisode ${String(episodeNumber ?? "").padStart(2, "0")}`;
  } else {
    const episodeOnly = /^(.*?)(?:^|[\s._-])(?:épisode|episode|ep)[\s._-]*(\d{1,3})(?:[\s._-]+(.*))?$/iu.exec(normalized);
    seasonNumber = safeNumber(pathSeason);
    episodeNumber = safeNumber(episodeOnly?.[2]);
    seriesTitle = episodeOnly ? (displayText(episodeOnly[1]) || fallbackSeries(torrentName, stem)) : fallbackSeries(torrentName, stem);
    episodeTitle = episodeOnly
      ? (displayText(episodeOnly[3] ?? "") || `Épisode ${String(episodeNumber ?? "").padStart(2, "0")}`)
      : (displayText(stem) || "Média sans titre");
  }

  return {
    seriesTitle,
    seasonNumber,
    episodeNumber,
    episodeTitle,
    extension,
    kind: AUDIO_EXTENSIONS.has(extension) ? "audio" : "video",
  };
}

function folded(value: string) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr");
}

export function canonicalMediaTitle(value: string) {
  return folded(value.replace(/\b(?:and|et)\b|&/giu, " et ")).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function compareNullableNumber(left: number | null, right: number | null) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

/** Regroupe d’abord par torrent, puis série et saison, sans inventer de métadonnées réseau. */
export function buildMediaLibrary(torrents: readonly MediaTorrentInput[], query = ""): TorrentMediaGroup[] {
  const needle = folded(query.trim());
  const torrentGroups: TorrentMediaGroup[] = [];

  for (const torrent of torrents) {
    const episodes = (torrent.files ?? [])
      .filter((file) => file.media && file.wanted !== false)
      .map((file): MediaEpisode => {
        const parsed = parseMediaIdentity(file.name, torrent.name);
        const completed = file.length > 0 && file.bytesCompleted >= file.length;
        const scanStatus = String(file.scanStatus || "not-scanned");
        return {
          ...parsed,
          key: `${torrent.id}:${file.index}`,
          watchKey: `${torrent.hash || `local-${torrent.id}`}:${file.index}`,
          torrentId: torrent.id,
          torrentName: torrent.name,
          addedAt: Number.isFinite(torrent.addedAt) ? torrent.addedAt : 0,
          fileIndex: file.index,
          fileName: file.name,
          length: file.length,
          completed,
          scanStatus,
          playable: completed && scanStatus === "clean",
          uploadRatio: Number(torrent.uploadRatio || 0),
        };
      });

    if (!episodes.length) continue;
    const torrentMatches = needle && folded(torrent.name).includes(needle);
    const visible = needle && !torrentMatches
      ? episodes.filter((episode) => {
        const seasonTerms = episode.seasonNumber === null
          ? "hors saison special spéciaux film"
          : `saison ${episode.seasonNumber} season ${episode.seasonNumber} s${episode.seasonNumber} ${episode.seasonNumber}`;
        const episodeTerms = episode.episodeNumber === null
          ? ""
          : `episode ${episode.episodeNumber} épisode ${episode.episodeNumber} ep ${episode.episodeNumber} e${episode.episodeNumber} ${episode.episodeNumber}`;
        return folded(`${episode.seriesTitle} ${seasonTerms} ${episodeTerms} ${episode.episodeTitle} ${episode.fileName} ${episode.kind}`).includes(needle);
      })
      : episodes;
    if (!visible.length) continue;

    const seriesMap = new Map<string, MediaSeriesGroup>();
    for (const episode of visible) {
      const seriesKey = folded(episode.seriesTitle);
      let series = seriesMap.get(seriesKey);
      if (!series) {
        series = { key: `${torrent.id}:${seriesKey}`, title: episode.seriesTitle, seasons: [] };
        seriesMap.set(seriesKey, series);
      }
      const seasonKey = episode.seasonNumber === null ? "specials" : `s${episode.seasonNumber}`;
      let season = series.seasons.find((candidate) => candidate.key.endsWith(`:${seasonKey}`));
      if (!season) {
        season = {
          key: `${series.key}:${seasonKey}`,
          label: episode.seasonNumber === null ? "Films et épisodes spéciaux" : `Saison ${episode.seasonNumber}`,
          seasonNumber: episode.seasonNumber,
          episodes: [],
        };
        series.seasons.push(season);
      }
      season.episodes.push(episode);
    }

    const series = Array.from(seriesMap.values()).sort((left, right) => left.title.localeCompare(right.title, "fr"));
    for (const item of series) {
      item.seasons.sort((left, right) => compareNullableNumber(left.seasonNumber, right.seasonNumber));
      for (const season of item.seasons) {
        season.episodes.sort((left, right) => compareNullableNumber(left.episodeNumber, right.episodeNumber) || left.episodeTitle.localeCompare(right.episodeTitle, "fr"));
      }
    }

    torrentGroups.push({
      key: String(torrent.id),
      torrentId: torrent.id,
      torrentName: torrent.name,
      total: visible.length,
      completed: visible.filter((episode) => episode.completed).length,
      playable: visible.filter((episode) => episode.playable).length,
      status: String(torrent.status || "stopped"),
      percentDone: Number(torrent.percentDone || 0),
      series,
    });
  }

  return torrentGroups.sort((left, right) => left.torrentName.localeCompare(right.torrentName, "fr"));
}

export function flattenPlayableSeries(group: TorrentMediaGroup, seriesKey: string) {
  return group.series.find((series) => series.key === seriesKey)?.seasons.flatMap((season) => season.episodes).filter((episode) => episode.playable) ?? [];
}

/** Relier les saisons locales d'une série sans rejouer les copies du même épisode. */
export function buildPlaybackQueue(episodes: readonly MediaEpisode[], current: MediaEpisode) {
  const episodic = current.episodeNumber !== null;
  const candidates = episodes.filter((episode) => episode.playable && episode.kind === current.kind && canonicalMediaTitle(episode.seriesTitle) === canonicalMediaTitle(current.seriesTitle)
    && (episodic ? episode.episodeNumber !== null : episode.torrentId === current.torrentId));
  const selected = new Map<string, MediaEpisode>();
  for (const episode of candidates) {
    const identity = episodic ? `${episode.seasonNumber}:${episode.episodeNumber}` : episode.key;
    const previous = selected.get(identity);
    if (!previous || episode.key === current.key || (previous.key !== current.key && previous.torrentId !== current.torrentId && episode.torrentId === current.torrentId)) selected.set(identity, episode);
  }
  return [...selected.values()].sort((left, right) => compareNullableNumber(left.seasonNumber, right.seasonNumber) || compareNullableNumber(left.episodeNumber, right.episodeNumber) || left.fileName.localeCompare(right.fileName, "fr", { numeric: true }));
}
