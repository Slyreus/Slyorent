"use client";

import { Check, ChevronDown, CirclePlay, FolderCog, FolderOpen, Library, LoaderCircle, LockKeyhole, ScanSearch, Search, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildMediaLibrary, buildPlaybackQueue, type MediaEpisode, type TorrentMediaGroup } from "../../lib/media-library";
import { canResume, formatMediaTime, MediaPlaybackSession, watchPercentage, type WatchRecord } from "../../lib/media-playback";
import { MediaPlayer } from "./MediaPlayer";
import { VideoThumbnail } from "./VideoThumbnail";
import "./media-library.css";

export type MediaBridge = Pick<NonNullable<Window["secuTorrent"]>, "openMedia" | "renewMedia" | "releaseMedia" | "cancelMediaPreparation" | "watchHistory" | "savePlayback" | "setMediaWatched" | "verifyAndScan" | "chooseDownloadDirectory" | "openDownloadDirectory" | "openTorrentDirectory">;
export type MediaLibraryProps = {
  torrents: readonly SecuTorrentTorrent[];
  bridge?: MediaBridge;
  initialQuery?: string;
  downloadDirectory?: string;
  onDirectoryChanged?: () => void;
  onNotice?: (tone: "success" | "error" | "info", message: string) => void;
  className?: string;
};
type WatchFilter = "all" | "continue" | "unwatched" | "completed";
const PAGE_SIZE = 50;
const flatten = (groups: TorrentMediaGroup[]) => groups.flatMap((group) => group.series.flatMap((series) => series.seasons.flatMap((season) => season.episodes)));
const readableError = (error: unknown) => error instanceof Error ? error.message : "Action indisponible.";

export function MediaLibraryView({ torrents, bridge, initialQuery = "", downloadDirectory = "", onDirectoryChanged, onNotice, className = "" }: MediaLibraryProps) {
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<WatchFilter>("all");
  const [collection, setCollection] = useState("");
  const [season, setSeason] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [history, setHistory] = useState<Record<string, WatchRecord>>({});
  const [historyReady, setHistoryReady] = useState(false);
  const [selected, setSelected] = useState<{ episode: MediaEpisode; record?: WatchRecord; session: MediaPlaybackSession } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const sessionRef = useRef<MediaPlaybackSession | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const getBridge = useCallback(() => {
    const candidate = bridge ?? window.secuTorrent;
    if (!candidate) throw new Error("Interface média indisponible.");
    return candidate;
  }, [bridge]);
  const updateProgress = useCallback((key: string, record: WatchRecord) => {
    setHistory((current) => current[key]?.updatedAt > record.updatedAt ? current : { ...current, [key]: record });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => getBridge().watchHistory()).then((records) => {
      if (!cancelled) { setHistory((current) => ({ ...records, ...current })); setHistoryReady(true); }
    }).catch(() => {
      if (!cancelled) { setError("Suivi de lecture indisponible. Fermer puis rouvrir la médiathèque."); setHistoryReady(true); }
    });
    return () => { cancelled = true; };
  }, [getBridge]);
  useEffect(() => () => sessionRef.current?.dispose(), []);

  const library = useMemo(() => buildMediaLibrary(torrents), [torrents]);
  const allEpisodes = useMemo(() => flatten(library), [library]);
  const searched = useMemo(() => flatten(buildMediaLibrary(torrents, query)), [torrents, query]);
  const selectedCollection = library.find((item) => String(item.torrentId) === collection);
  const availableSeasons = [...new Set(allEpisodes.filter((episode) => !collection || String(episode.torrentId) === collection).map((episode) => episode.seasonNumber).filter((number) => number !== null))].sort((a, b) => a - b);
  const filtered = searched.filter((episode) => {
    if (collection && String(episode.torrentId) !== collection) return false;
    if (season && String(episode.seasonNumber) !== season) return false;
    const record = history[episode.watchKey];
    return filter === "all" || (filter === "continue" && canResume(record)) || (filter === "completed" && record?.completed) || (filter === "unwatched" && !record?.completed && !canResume(record));
  });
  if (filter === "continue") filtered.sort((a, b) => (history[b.watchKey]?.updatedAt || 0) - (history[a.watchKey]?.updatedAt || 0));
  const continuing = allEpisodes.filter((episode) => episode.playable && canResume(history[episode.watchKey])).sort((a, b) => history[b.watchKey].updatedAt - history[a.watchKey].updatedAt);
  const completedCount = allEpisodes.filter((episode) => history[episode.watchKey]?.completed).length;

  function play(episode: MediaEpisode, trigger?: HTMLElement) {
    if (!episode.playable) return;
    if (trigger) returnFocusRef.current = trigger;
    if (!sessionRef.current) sessionRef.current = new MediaPlaybackSession(getBridge());
    setSelected({ episode, record: history[episode.watchKey], session: sessionRef.current });
  }

  function closePlayer() {
    setSelected(null);
    sessionRef.current?.dispose();
    sessionRef.current = null;
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  }

  async function runAction(key: string, task: () => Promise<unknown>) {
    setBusy(key);
    setError("");
    try { await task(); }
    catch (caught) { const message = readableError(caught); setError(message); onNotice?.("error", message); }
    finally { setBusy(""); }
  }

  async function markWatched(episode: MediaEpisode) {
    await runAction(`watched-${episode.key}`, async () => {
      const record = await getBridge().setMediaWatched({ id: episode.torrentId, fileIndex: episode.fileIndex, watched: !history[episode.watchKey]?.completed });
      updateProgress(record.key, record);
    });
  }

  const playlist = selected ? buildPlaybackQueue(allEpisodes, selected.episode) : [];
  const playlistIndex = playlist.findIndex((episode) => episode.key === selected?.episode.key);
  const renderCollectionTools = (group: TorrentMediaGroup) => <div className="sly-media-collection-tools" key={group.key}>
    <span title={group.torrentName}><Library size={16} /><strong>{group.torrentName}</strong><small>{group.playable}/{group.total} prêts</small></span>
    <button type="button" disabled={Boolean(busy) || group.percentDone < .999999 || ["verifying", "queued-verification"].includes(group.status)} onClick={() => void runAction(`scan-${group.key}`, async () => { await getBridge().verifyAndScan(group.torrentId); onNotice?.("success", "Vérification et analyse terminées."); })}>
      {busy === `scan-${group.key}` ? <LoaderCircle size={15} className="sly-media-spin" /> : <ScanSearch size={15} />} Vérifier et analyser
    </button>
    <button type="button" disabled={Boolean(busy)} onClick={() => void runAction(`folder-${group.key}`, () => getBridge().openTorrentDirectory(group.torrentId))}><FolderOpen size={15} /> Dossier</button>
  </div>;

  return <section className={`sly-media-library ${className}`.trim()} data-testid="media-library" aria-labelledby="sly-media-library-title">
    <header className="sly-media-hero">
      <div className="sly-media-hero-copy"><span className="sly-media-eyebrow"><Library size={14} /> SLYORRENT / MÉDIAS LOCAUX</span><h1 id="sly-media-library-title">Médiathèque</h1><p>{allEpisodes.length} médias · {continuing.length} à reprendre · {completedCount} terminés</p></div>
      <div className="sly-media-hero-art" aria-hidden="true"><img src="./slyorus.png" alt="" /><span><ShieldCheck size={13} /> Lecture après validation</span></div>
    </header>

    {continuing.length > 0 && filter === "all" && !query && !collection && <section className="sly-media-resume-section" aria-label="À reprendre">
      <header><h2>À reprendre</h2><button type="button" onClick={() => { setFilter("continue"); setLimit(PAGE_SIZE); }}>Tout voir <span>{continuing.length}</span></button></header>
      <div className="sly-media-resume-cards">{continuing.slice(0, 4).map((episode) => <button type="button" key={episode.key} onClick={(event) => play(episode, event.currentTarget)}>
        <VideoThumbnail episode={episode} getBridge={getBridge} suspended={Boolean(selected)} />
        <span className="sly-media-resume-copy"><small>{episode.seriesTitle} · {episodeLabel(episode)}</small><strong>{episode.episodeTitle}</strong><span><CirclePlay size={14} /> Reprendre à {formatMediaTime(history[episode.watchKey].position)}</span><WatchProgress record={history[episode.watchKey]} /></span>
      </button>)}</div>
    </section>}

    <div className="sly-media-toolbar">
      <label className="sly-media-search"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} type="search" placeholder="Série, film, épisode…" aria-label="Rechercher dans la médiathèque" /></label>
      <div className="sly-media-folder-tools"><span className="sly-media-folder-label" title={downloadDirectory}><FolderOpen size={15} /><span><small>BIBLIOTHÈQUE</small><b>{downloadDirectory.split(/[\\/]/u).filter(Boolean).at(-1) || "Dossier local"}</b></span></span>
        <button type="button" disabled={Boolean(busy)} onClick={() => void runAction("choose", async () => { if (!(await getBridge().chooseDownloadDirectory()).canceled) onDirectoryChanged?.(); })}><FolderCog size={15} /> Changer</button>
        <button type="button" disabled={Boolean(busy)} onClick={() => void runAction("open", () => getBridge().openDownloadDirectory())}><FolderOpen size={15} /> Ouvrir</button>
      </div>
    </div>
    <div className="sly-media-filters">
      <div className="sly-media-filter-tabs" role="group" aria-label="Filtrer par visionnage">{([["all", "Tout"], ["continue", "À reprendre"], ["unwatched", "Non vus"], ["completed", "Terminés"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setLimit(PAGE_SIZE); }}>{label}</button>)}</div>
      <select aria-label="Filtrer par torrent" value={collection} onChange={(event) => { setCollection(event.target.value); setSeason(""); setLimit(PAGE_SIZE); }}><option value="">Tous les torrents</option>{library.map((group) => <option key={group.key} value={String(group.torrentId)}>{group.torrentName}</option>)}</select>
      <select aria-label="Filtrer par saison" value={season} onChange={(event) => { setSeason(event.target.value); setLimit(PAGE_SIZE); }}><option value="">Toutes les saisons</option>{availableSeasons.map((number) => <option key={number} value={String(number)}>Saison {number}</option>)}</select>
      <span className="sly-media-result" role="status">{filtered.length} média{filtered.length > 1 ? "s" : ""}</span>
    </div>

    {error && <div className="sly-media-alert" role="alert"><LockKeyhole size={16} /> {error}<button type="button" onClick={() => setError("")} aria-label="Fermer l’alerte"><X size={14} /></button></div>}
    {selectedCollection ? renderCollectionTools(selectedCollection) : library.length > 0 && <details className="sly-media-manage"><summary><FolderCog size={15} /> Dossiers et analyses <ChevronDown size={14} /></summary><div>{library.map(renderCollectionTools)}</div></details>}

    <div className="sly-media-list" aria-label="Médias">
      {filtered.slice(0, limit).map((episode) => <article key={episode.key} className={`sly-media-row ${history[episode.watchKey]?.completed ? "is-watched" : ""}`}>
        <button type="button" className="sly-media-row-main" disabled={!episode.playable || !historyReady} onClick={(event) => play(episode, event.currentTarget)} aria-label={`Lire ${episode.seriesTitle} ${episodeLabel(episode)} — ${episode.episodeTitle}`} title={episode.playable ? episode.fileName : episode.completed ? "Vérification et analyse requises" : "Téléchargement incomplet"}>
          <VideoThumbnail episode={episode} getBridge={getBridge} suspended={Boolean(selected)} />
          <span className="sly-media-row-copy"><strong>{episode.episodeTitle}</strong><span>{episode.seriesTitle} <b>{episodeLabel(episode)}</b></span><small>{episode.playable ? <><ShieldCheck size={11} /> Validé</> : <><LockKeyhole size={11} /> {episode.completed ? "Analyse requise" : "Incomplet"}</>} · {episode.extension.toUpperCase()}</small></span>
          <WatchProgress record={history[episode.watchKey]} />
          <span className="sly-media-play-icon"><CirclePlay size={25} /></span>
        </button>
        <button type="button" className="sly-media-mark" disabled={!historyReady || Boolean(busy)} aria-label={`${history[episode.watchKey]?.completed ? "Marquer comme non vu" : "Marquer comme vu"} : ${episode.episodeTitle}`} title={history[episode.watchKey]?.completed ? "Marquer comme non vu" : "Marquer comme vu"} aria-pressed={Boolean(history[episode.watchKey]?.completed)} onClick={() => void markWatched(episode)}>{busy === `watched-${episode.key}` ? <LoaderCircle size={16} className="sly-media-spin" /> : <Check size={17} />}</button>
      </article>)}
    </div>
    {filtered.length > limit && <button className="sly-media-load-more" type="button" onClick={() => setLimit((value) => value + PAGE_SIZE)}>Afficher la suite · {filtered.length - limit} médias</button>}
    {!filtered.length && <div className="sly-media-empty"><Library size={26} /><h2>{allEpisodes.length ? "Aucun média correspondant" : "Aucun média détecté"}</h2><p>{allEpisodes.length ? "Changer les filtres ou la recherche." : "Les vidéos et pistes audio apparaîtront ici."}</p></div>}

    {selected && <MediaPlayer key={selected.episode.key} episode={selected.episode} initialRecord={selected.record} session={selected.session} getBridge={getBridge} previous={playlist[playlistIndex - 1]} next={playlist[playlistIndex + 1]} onSelect={play} onClose={closePlayer} onProgress={updateProgress} />}
  </section>;
}

export function episodeLabel(episode: MediaEpisode) {
  const season = episode.seasonNumber === null ? "" : `S${String(episode.seasonNumber).padStart(2, "0")}`;
  return episode.episodeNumber === null ? episode.kind === "audio" ? "Audio" : "Film" : `${season} E${String(episode.episodeNumber).padStart(2, "0")}`.trim();
}

function WatchProgress({ record }: { record?: WatchRecord }) {
  const percentage = watchPercentage(record);
  return <span className={`sly-media-progress ${record?.completed ? "is-complete" : ""}`}>
    <span><b>{record?.completed ? "Vu" : canResume(record) ? formatMediaTime(record?.position || 0) : "Non vu"}</b><small>{percentage} %</small></span>
    <span className="sly-media-progress-track" role="progressbar" aria-label="Visionnage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}><i style={{ width: `${percentage}%` }} /></span>
  </span>;
}
