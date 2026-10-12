"use client";

import { ArrowDownWideNarrow, ArrowLeft, ArrowUpWideNarrow, Check, ChevronDown, ChevronRight, CirclePlay, Film, FolderCog, FolderOpen, LayoutGrid, Library, List, LoaderCircle, LockKeyhole, Music2, ScanSearch, Search, ShieldCheck, SlidersHorizontal, Star, Tv, X } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { buildMediaLibrary, buildPlaybackQueue, type MediaEpisode, type TorrentMediaGroup } from "../../lib/media-library";
import { EMPTY_FILTERS, filterCatalog, formatLibrarySize, groupCatalog, nextToWatch, sortCatalog, titleKey, titleOf, type CatalogFilters, type CatalogGroup } from "../../lib/library-catalog";
import { LIBRARY_DEFAULTS, type LibraryPreferencePatch, type LibraryPreferences } from "../../electron/library-preferences-schema.mjs";
import { canResume, formatMediaTime, MediaPlaybackSession, watchPercentage, type WatchRecord } from "../../lib/media-playback";
import { MediaPlayer } from "./MediaPlayer";
import { CastPanel } from "./CastPanel";
import type { CastRequest } from "../../lib/media-cast";
import { VideoThumbnail } from "./VideoThumbnail";
import "./media-library.css";
import "./library-catalog.css";

type Bridge = NonNullable<Window["secuTorrent"]>;
export type MediaBridge = Pick<Bridge, "openMedia" | "renewMedia" | "releaseMedia" | "cancelMediaPreparation" | "mediaPreparation" | "watchHistory" | "savePlayback" | "setMediaWatched" | "verifyAndScan" | "chooseDownloadDirectory" | "openDownloadDirectory" | "openTorrentDirectory"> & Partial<Pick<Bridge, "openSubtitle" | "libraryPreferences" | "saveLibraryPreferences" | "castDiscover" | "castStart" | "castStatus" | "castControl">>;
export type MediaLibraryProps = {
  torrents: readonly SecuTorrentTorrent[]; bridge?: MediaBridge; initialQuery?: string; onQueryChange?: (value: string) => void;
  downloadDirectory?: string; onDirectoryChanged?: () => void;
  onNotice?: (tone: "success" | "error" | "info", message: string) => void; className?: string;
};
const PAGE_SIZE = 36;
const NO_EPISODES: MediaEpisode[] = [];
const CATEGORY_LABELS = { all: "Tous les médias", series: "Séries", movie: "Films et vidéos", audio: "Audio" };
const flatten = (groups: TorrentMediaGroup[]) => groups.flatMap((group) => group.series.flatMap((series) => series.seasons.flatMap((season) => season.episodes)));
const readableError = (error: unknown) => error instanceof Error ? error.message : "Action indisponible.";

export function MediaLibraryView({ torrents, bridge, initialQuery = "", onQueryChange, downloadDirectory = "", onDirectoryChanged, onNotice, className = "" }: MediaLibraryProps) {
  const [filters, setFilters] = useState<CatalogFilters>({ ...EMPTY_FILTERS, query: initialQuery });
  const [preferences, setPreferences] = useState<LibraryPreferences>({ ...LIBRARY_DEFAULTS, favorites: [] });
  const preferencesRef = useRef(preferences), preferenceRevision = useRef(0);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [history, setHistory] = useState<Record<string, WatchRecord>>({});
  const [historyReady, setHistoryReady] = useState(false);
  const [selected, setSelected] = useState<{ episode: MediaEpisode; record?: WatchRecord; session: MediaPlaybackSession } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [castRequest, setCastRequest] = useState<CastRequest | null>(null);
  const sessionRef = useRef<MediaPlaybackSession | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null), detailRef = useRef<HTMLHeadingElement | null>(null);
  const query = onQueryChange ? initialQuery : filters.query;
  const deferredQuery = useDeferredValue(query);
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
    }).catch(() => { if (!cancelled) { setError("Suivi de lecture indisponible."); setHistoryReady(true); } });
    void Promise.resolve().then(() => getBridge().libraryPreferences?.()).then((value) => {
      if (!cancelled) { if (value) { preferencesRef.current = value; setPreferences(value); } setPreferencesReady(true); }
    }).catch(() => { if (!cancelled) { setError("Préférences locales indisponibles."); setPreferencesReady(true); } });
    return () => { cancelled = true; };
  }, [getBridge]);
  useEffect(() => () => sessionRef.current?.dispose(), []);
  useEffect(() => { if (detailKey) detailRef.current?.focus(); }, [detailKey]);

  function changeFilters(patch: Partial<CatalogFilters>) {
    if (patch.query !== undefined) onQueryChange?.(patch.query);
    setFilters((current) => ({ ...current, ...patch })); setLimit(PAGE_SIZE);
  }
  function resetFilters() { changeFilters({ ...EMPTY_FILTERS }); }
  async function savePreferences(patch: LibraryPreferencePatch) {
    const { favorite, ...settings } = patch;
    const current = preferencesRef.current;
    const favorites = favorite ? [...current.favorites.filter((key) => key !== favorite.key), ...(favorite.value ? [favorite.key] : [])] : current.favorites;
    const next = { ...current, ...settings, favorites };
    preferencesRef.current = next; setPreferences(next); setLimit(PAGE_SIZE);
    const revision = ++preferenceRevision.current;
    try {
      const saved = await getBridge().saveLibraryPreferences?.(patch);
      if (saved && revision === preferenceRevision.current) { preferencesRef.current = saved; setPreferences(saved); }
    } catch { setError("Classement non enregistré. Réessayez après avoir rouvert la médiathèque."); }
  }
  const toggleFavorite = (key: string) => void savePreferences({ favorite: { key, value: !preferencesRef.current.favorites.includes(key) } });
  const library = useMemo(() => buildMediaLibrary(torrents), [torrents]);
  const allEpisodes = useMemo(() => flatten(library), [library]);
  const allTitles = useMemo(() => groupCatalog(allEpisodes, "title", preferences, history), [allEpisodes, preferences, history]);
  const allGroups = useMemo(() => preferences.groupBy === "torrent" ? groupCatalog(allEpisodes, "torrent", preferences, history) : allTitles, [allEpisodes, preferences, history, allTitles]);
  const detail = detailKey ? allGroups.find((group) => group.key === detailKey) : undefined;
  const scoped = detailKey ? detail?.episodes ?? NO_EPISODES : allEpisodes;
  const filtered = useMemo(() => filterCatalog(scoped, { ...filters, query: deferredQuery }, history, preferences.favorites), [scoped, filters, deferredQuery, history, preferences.favorites]);
  const ordered = useMemo(() => sortCatalog(filtered, preferences, history), [filtered, preferences, history]);
  const groups = useMemo(() => groupCatalog(filtered, preferences.groupBy === "torrent" ? "torrent" : "title", preferences, history), [filtered, preferences, history]);
  const continuing = allEpisodes.filter((episode) => episode.playable && canResume(history[episode.watchKey])).sort((a, b) => history[b.watchKey].updatedAt - history[a.watchKey].updatedAt);
  const availableSeasons = [...new Set(scoped.filter((episode) => !filters.torrent || String(episode.torrentId) === filters.torrent).map((episode) => episode.seasonNumber).filter((value) => value !== null))].sort((a, b) => a - b);
  const scopedTorrents = library.filter((group) => scoped.some((episode) => episode.torrentId === group.torrentId));
  const activeFilterCount = Number(Boolean(query)) + Number(filters.category !== "all") + Number(filters.watch !== "all") + Number(filters.availability !== "all") + Number(filters.favoritesOnly) + Number(Boolean(filters.torrent)) + Number(Boolean(filters.season));
  const showCards = preferences.view === "titles" && !detailKey;
  const itemCount = showCards ? groups.length : ordered.length;
  const visibleListKeys = new Set((!detailKey && preferences.groupBy !== "none" ? groups.flatMap((group) => sortCatalog(group.episodes, preferences, history)) : ordered).slice(0, limit).map((item) => item.key));
  const playlist = selected ? buildPlaybackQueue(allEpisodes, selected.episode) : [];
  const playlistIndex = playlist.findIndex((episode) => episode.key === selected?.episode.key);
  const readyCount = allEpisodes.filter((episode) => episode.playable).length;

  function play(episode: MediaEpisode, trigger?: HTMLElement) {
    if (!episode.playable || !historyReady) return;
    if (trigger) returnFocusRef.current = trigger;
    if (!sessionRef.current) sessionRef.current = new MediaPlaybackSession(getBridge());
    setSelected({ episode, record: history[episode.watchKey], session: sessionRef.current });
  }
  function closePlayer(restoreFocus = true) {
    setSelected(null); sessionRef.current?.dispose(); sessionRef.current = null;
    if (restoreFocus) window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  }
  function leaveDetail() {
    const key = detailKey;
    setDetailKey(null); changeFilters({ season: "" });
    window.requestAnimationFrame(() => [...document.querySelectorAll<HTMLButtonElement>("[data-group-key]")].find((button) => button.dataset.groupKey === key)?.focus());
  }
  async function runAction(key: string, task: () => Promise<unknown>) {
    setBusy(key); setError("");
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
  const thumbnail = (episode: MediaEpisode) => <VideoThumbnail episode={episode} getBridge={getBridge} suspended={Boolean(selected)} />;
  const favoriteButton = (episode: MediaEpisode) => <button className="sly-catalog-star" type="button" disabled={!preferencesReady} aria-label={`${preferences.favorites.includes(titleKey(episode)) ? "Retirer des favoris" : "Ajouter aux favoris"} : ${titleOf(episode)}`} aria-pressed={preferences.favorites.includes(titleKey(episode))} onClick={() => toggleFavorite(titleKey(episode))}><Star size={17} /></button>;
  const renderTools = (group: TorrentMediaGroup) => <div className="sly-media-collection-tools" key={group.key}>
    <span title={group.torrentName}><Library size={16} /><strong>{group.torrentName}</strong><small>{group.playable}/{group.total} prêts</small></span>
    <button type="button" disabled={Boolean(busy) || group.percentDone < .999999 || ["verifying", "queued-verification"].includes(group.status)} onClick={() => void runAction(`scan-${group.key}`, async () => { await getBridge().verifyAndScan(group.torrentId); onNotice?.("success", "Vérification et analyse terminées."); })}>{busy === `scan-${group.key}` ? <LoaderCircle size={15} className="sly-media-spin" /> : <ScanSearch size={15} />} Vérifier et analyser</button>
    <button type="button" disabled={Boolean(busy)} onClick={() => void runAction(`folder-${group.key}`, () => getBridge().openTorrentDirectory(group.torrentId))}><FolderOpen size={15} /> Dossier</button>
  </div>;
  const renderRow = (episode: MediaEpisode) => <article key={episode.key} className={`sly-media-row ${history[episode.watchKey]?.completed ? "is-watched" : ""}`}>
    <button type="button" className="sly-media-row-main" disabled={!episode.playable || !historyReady} onClick={(event) => play(episode, event.currentTarget)} aria-label={`Lire ${episode.seriesTitle} ${episodeLabel(episode)} — ${episode.episodeTitle}`} title={episode.playable ? episode.fileName : episode.completed ? "Vérification et analyse requises" : "Téléchargement incomplet"}>
      {thumbnail(episode)}<span className="sly-media-row-copy"><strong>{episode.episodeTitle}</strong><span>{episode.seriesTitle} <b>{episodeLabel(episode)}</b></span><small>{episode.playable ? <ShieldCheck size={11} /> : <LockKeyhole size={11} />}{episode.playable ? "Prêt" : episode.completed ? "À vérifier" : "Incomplet"} · {episode.extension.toUpperCase()} · {formatLibrarySize(episode.length)}<span className="sly-catalog-source" title={episode.torrentName}> · {episode.torrentName}</span></small></span>
      <WatchProgress record={history[episode.watchKey]} /><span className="sly-media-play-icon"><CirclePlay size={23} /></span>
    </button>
    <div className="sly-catalog-row-actions">{favoriteButton(episode)}<button type="button" className="sly-media-mark" disabled={!historyReady || Boolean(busy)} aria-label={`${history[episode.watchKey]?.completed ? "Marquer comme non vu" : "Marquer comme vu"} : ${episode.episodeTitle}`} title="Statut de visionnage" aria-pressed={Boolean(history[episode.watchKey]?.completed)} onClick={() => void markWatched(episode)}>{busy === `watched-${episode.key}` ? <LoaderCircle size={16} className="sly-media-spin" /> : <Check size={16} />}</button><button className="sly-catalog-folder" type="button" disabled={Boolean(busy)} aria-label={`Ouvrir le dossier : ${episode.episodeTitle}`} onClick={() => void runAction(`folder-${episode.key}`, () => getBridge().openTorrentDirectory(episode.torrentId))}><FolderOpen size={16} /></button></div>
  </article>;
  const renderCard = (group: CatalogGroup) => {
    const next = nextToWatch(group.episodes, history), cover = next || group.episodes[0];
    return <article className="sly-catalog-card" key={group.key}>
      <button className="sly-catalog-card-open" type="button" data-group-key={group.key} aria-label={`Voir les fichiers : ${group.title}`} onClick={() => { setDetailKey(group.key); changeFilters({ season: "" }); }}>
        {thumbnail(cover)}<span className="sly-catalog-card-tag">{group.category === "series" ? <Tv size={12} /> : group.category === "audio" ? <Music2 size={12} /> : <Film size={12} />}{CATEGORY_LABELS[group.category]}</span>
        <span className="sly-catalog-card-copy"><strong title={group.title}>{group.title}</strong><span>{group.episodes.length} fichier{group.episodes.length > 1 ? "s" : ""}{group.seasons.length > 0 ? ` · ${group.seasons.length} saison${group.seasons.length > 1 ? "s" : ""}` : ` · ${formatLibrarySize(group.bytes)}`}</span><small>{group.torrents} torrent{group.torrents > 1 ? "s" : ""} · {group.ready} prêt{group.ready > 1 ? "s" : ""}<ChevronRight size={14} /></small></span>
      </button>
      {preferences.groupBy !== "torrent" && <div className="sly-catalog-card-star">{favoriteButton(cover)}</div>}
      <div className="sly-catalog-card-progress" title={`${group.watched} / ${group.episodes.length} vus`}><i style={{ width: `${group.watched / group.episodes.length * 100}%` }} /></div>
      <footer><button type="button" disabled={!next || !historyReady} onClick={(event) => next && play(next, event.currentTarget)} aria-label={`Lire directement : ${group.title}`}><CirclePlay size={17} /><span>{next && canResume(history[next.watchKey]) ? "Reprendre" : group.watched === group.episodes.length ? "Revoir" : "Lire"}{next?.episodeNumber !== null && next ? <small>{episodeLabel(next)}</small> : null}</span></button><span>{group.watched}/{group.episodes.length} vus</span></footer>
    </article>;
  };

  return <section className={`sly-media-library sly-catalog ${className}`.trim()} data-testid="media-library" aria-labelledby="sly-media-library-title">
    <CastPanel getBridge={getBridge} request={castRequest} onDismiss={() => setCastRequest(null)} onStarted={() => closePlayer(false)} onProgress={updateProgress} />
    <header className="sly-catalog-heading"><div><span className="sly-media-eyebrow"><Library size={13} /> BIBLIOTHÈQUE LOCALE</span><h1 id="sly-media-library-title">Médiathèque<span>{allTitles.length} titres</span></h1><p>{allEpisodes.length} fichiers <span>·</span> {readyCount} prêts à lire</p></div><div className="sly-media-folder-tools"><button type="button" disabled={Boolean(busy)} title={downloadDirectory} onClick={() => void runAction("open", () => getBridge().openDownloadDirectory())}><FolderOpen size={16} /> Bibliothèque</button><button type="button" disabled={Boolean(busy)} aria-label="Changer le dossier de bibliothèque" title="Changer le dossier" onClick={() => void runAction("choose", async () => { if (!(await getBridge().chooseDownloadDirectory()).canceled) onDirectoryChanged?.(); })}><FolderCog size={16} /></button></div></header>
    <nav className="sly-catalog-categories" aria-label="Types de médias">{(["all", "series", "movie", "audio"] as const).map((value) => { const Icon = value === "series" ? Tv : value === "movie" ? Film : value === "audio" ? Music2 : Library; return <button type="button" key={value} aria-pressed={filters.category === value && !filters.favoritesOnly} onClick={() => { setDetailKey(null); changeFilters({ category: value, favoritesOnly: false, torrent: "", season: "" }); }}><Icon size={16} />{value === "all" ? "Tout" : CATEGORY_LABELS[value]}<span>{value === "all" ? allTitles.length : allTitles.filter((item) => item.category === value).length}</span></button>; })}<button type="button" className="sly-catalog-favorites" aria-pressed={filters.favoritesOnly} onClick={() => { setDetailKey(null); changeFilters({ favoritesOnly: !filters.favoritesOnly, category: "all", torrent: "", season: "" }); }}><Star size={16} /> Favoris<span>{allTitles.filter((item) => preferences.favorites.includes(item.key)).length}</span></button></nav>
    {error && <div className="sly-media-alert" role="alert"><LockKeyhole size={16} />{error}<button type="button" onClick={() => setError("")} aria-label="Fermer l’alerte"><X size={14} /></button></div>}
    {detail && <div className="sly-catalog-detail"><button type="button" onClick={leaveDetail}><ArrowLeft size={16} /> Retour aux titres</button><h2 ref={detailRef} tabIndex={-1}>{detail.title}</h2><p>{detail.episodes.length} fichiers · {detail.torrents} torrent{detail.torrents > 1 ? "s" : ""}</p></div>}
    {!detail && continuing.length > 0 && !activeFilterCount && <section className="sly-media-resume-section" aria-label="À reprendre"><header><h2>Reprendre la lecture</h2><button type="button" onClick={() => { changeFilters({ watch: "continue" }); void savePreferences({ view: "list", sort: "watched", descending: true }); }}>Tout voir <span>{continuing.length}</span></button></header><div className="sly-media-resume-cards">{continuing.slice(0, 3).map((episode) => <button type="button" key={episode.key} onClick={(event) => play(episode, event.currentTarget)}>{thumbnail(episode)}<span className="sly-media-resume-copy"><small>{episode.seriesTitle} · {episodeLabel(episode)}</small><strong>{episode.episodeTitle}</strong><span><CirclePlay size={14} /> {formatMediaTime(history[episode.watchKey].position)}</span><WatchProgress record={history[episode.watchKey]} /></span></button>)}</div></section>}
    <div className="sly-catalog-controls">
      <div className="sly-catalog-search-line"><label className="sly-media-search"><Search size={18} /><input value={query} onChange={(event) => changeFilters({ query: event.target.value })} type="search" placeholder="Un titre, un épisode, un torrent…" aria-label="Rechercher dans la médiathèque" />{query && <button type="button" aria-label="Effacer la recherche" onClick={() => changeFilters({ query: "" })}><X size={15} /></button>}</label><button type="button" className="sly-catalog-refine-toggle" aria-expanded={refineOpen} aria-controls="sly-catalog-refine" onClick={() => setRefineOpen((value) => !value)}><SlidersHorizontal size={16} /> Filtres{activeFilterCount > 0 && <span>{activeFilterCount}</span>}</button><div className="sly-catalog-view" role="group" aria-label="Affichage">{(["titles", "list"] as const).map((view) => <button type="button" key={view} disabled={!preferencesReady} aria-label={view === "titles" ? "Vue Titres" : "Vue Liste"} aria-pressed={preferences.view === view} onClick={() => { setDetailKey(null); void savePreferences({ view, ...(view === "titles" && preferences.groupBy === "none" ? { groupBy: "title" } : {}) }); }}>{view === "titles" ? <LayoutGrid size={16} /> : <List size={16} />}{view === "titles" ? "Titres" : "Liste"}</button>)}</div></div>
      <div className="sly-catalog-sort-line"><div className="sly-media-filter-tabs" role="group" aria-label="Filtrer par visionnage">{([["all", "Tout"], ["continue", "À reprendre"], ["unwatched", "Non vus"], ["completed", "Terminés"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filters.watch === value} onClick={() => changeFilters({ watch: value })}>{label}</button>)}</div><div className="sly-catalog-sort"><label>Trier<select aria-label="Trier la médiathèque" disabled={!preferencesReady} value={preferences.sort} onChange={(event) => void savePreferences({ sort: event.target.value as LibraryPreferences["sort"], descending: event.target.value !== "title" })}><option value="title">Titre</option><option value="added">Date d’ajout</option><option value="watched">Dernière lecture</option><option value="size">Taille</option></select></label><button type="button" disabled={!preferencesReady} title={preferences.descending ? "Ordre décroissant" : "Ordre croissant"} aria-label={preferences.descending ? "Passer en ordre croissant" : "Passer en ordre décroissant"} onClick={() => void savePreferences({ descending: !preferences.descending })}>{preferences.descending ? <ArrowDownWideNarrow size={17} /> : <ArrowUpWideNarrow size={17} />}</button>{!detail && <label>Regrouper<select aria-label="Regrouper la médiathèque" disabled={!preferencesReady} value={preferences.groupBy} onChange={(event) => void savePreferences({ groupBy: event.target.value as LibraryPreferences["groupBy"] })}><option value="title">Par titre</option><option value="torrent">Par torrent</option>{preferences.view === "list" && <option value="none">Sans regroupement</option>}</select></label>}</div></div>
      {refineOpen && <div id="sly-catalog-refine" className="sly-catalog-refine"><label>Disponibilité<select aria-label="Filtrer par disponibilité" value={filters.availability} onChange={(event) => changeFilters({ availability: event.target.value as CatalogFilters["availability"] })}><option value="all">Tous les fichiers</option><option value="ready">Prêts à lire</option><option value="pending">À télécharger ou vérifier</option></select></label><label>Torrent<select aria-label="Filtrer par torrent" value={filters.torrent} onChange={(event) => changeFilters({ torrent: event.target.value, season: "" })}><option value="">Tous les torrents</option>{scopedTorrents.map((group) => <option key={group.key} value={String(group.torrentId)}>{group.torrentName}</option>)}</select></label>{!detail && availableSeasons.length > 0 && <label>Saison<select aria-label="Filtrer par saison" value={filters.season} onChange={(event) => changeFilters({ season: event.target.value })}><option value="">Toutes les saisons</option>{availableSeasons.map((number) => <option key={number} value={String(number)}>Saison {number}</option>)}</select></label>}</div>}
    </div>
    {detail && availableSeasons.length > 0 && <div className="sly-catalog-seasons" role="group" aria-label="Saisons"><button type="button" aria-pressed={!filters.season} onClick={() => changeFilters({ season: "" })}>Tout</button>{availableSeasons.map((number) => <button type="button" key={number} aria-pressed={filters.season === String(number)} onClick={() => changeFilters({ season: String(number) })}>{number === 0 ? "Spéciaux" : `Saison ${number}`}</button>)}</div>}
    <div className="sly-catalog-results"><span role="status" aria-live="polite">{itemCount} {showCards ? `titre${itemCount > 1 ? "s" : ""}` : `fichier${itemCount > 1 ? "s" : ""}`}{filtered.length !== allEpisodes.length ? ` · ${filtered.length} / ${allEpisodes.length} fichiers` : ""}</span>{activeFilterCount > 0 && <div className="sly-catalog-active-filters">{query && <button type="button" onClick={() => changeFilters({ query: "" })}>« {query} » <X size={12} /></button>}{filters.watch !== "all" && <button type="button" onClick={() => changeFilters({ watch: "all" })}>{filters.watch === "continue" ? "À reprendre" : filters.watch === "completed" ? "Terminés" : "Non vus"}<X size={12} /></button>}{filters.availability !== "all" && <button type="button" onClick={() => changeFilters({ availability: "all" })}>{filters.availability === "ready" ? "Prêts" : "En attente"}<X size={12} /></button>}{filters.torrent && <button type="button" onClick={() => changeFilters({ torrent: "", season: "" })}>Torrent filtré<X size={12} /></button>}{filters.season && <button type="button" onClick={() => changeFilters({ season: "" })}>Saison {filters.season}<X size={12} /></button>}<button type="button" className="sly-catalog-reset" onClick={resetFilters}>Tout effacer</button></div>}</div>
    {showCards ? <div className="sly-catalog-grid">{groups.slice(0, limit).map(renderCard)}</div> : <div className="sly-catalog-list-sections">{preferences.groupBy === "none" || detailKey ? <div className="sly-media-list">{ordered.slice(0, limit).map(renderRow)}</div> : groups.map((group) => { const visible = sortCatalog(group.episodes.filter((item) => visibleListKeys.has(item.key)), preferences, history); return visible.length > 0 && <section key={group.key} className="sly-catalog-list-group"><h3>{group.title}<span>{group.episodes.length} fichiers</span></h3><div className="sly-media-list">{visible.map(renderRow)}</div></section>; })}</div>}
    {itemCount > limit && <button className="sly-media-load-more" type="button" onClick={() => setLimit((value) => value + PAGE_SIZE)}>Afficher la suite · {itemCount - limit}</button>}
    {itemCount === 0 && <div className="sly-media-empty"><Search size={28} /><h2>{allEpisodes.length ? "Aucun résultat" : "La médiathèque est vide"}</h2><p>{allEpisodes.length ? "Aucun fichier ne correspond à ces filtres." : "Les médias de vos torrents apparaîtront ici."}</p>{activeFilterCount > 0 && <button type="button" className="sly-media-load-more" onClick={resetFilters}>Effacer les filtres</button>}{detailKey && !detail && <button type="button" onClick={leaveDetail}>Revenir à la bibliothèque</button>}</div>}
    {library.length > 0 && <details className="sly-media-manage sly-catalog-manage"><summary><FolderCog size={16} /> Dossiers et vérifications <span>{scopedTorrents.length}</span><ChevronDown size={14} /></summary><div>{scopedTorrents.map(renderTools)}</div></details>}
    {selected && <MediaPlayer key={selected.episode.key} episode={selected.episode} initialRecord={selected.record} session={selected.session} getBridge={getBridge} previous={playlist[playlistIndex - 1]} next={playlist[playlistIndex + 1]} onSelect={play} onClose={closePlayer} onProgress={updateProgress} onCast={(options) => { const videos = playlist.filter((item) => item.kind === "video"); const index = videos.findIndex((item) => item.key === selected.episode.key); if (index < 0) throw new Error("File de lecture indisponible."); const offset = Math.max(0, index - 25); setCastRequest({ ...options, queue: videos.slice(offset, offset + 250).map((item) => ({ id: item.torrentId, fileIndex: item.fileIndex, title: `${item.seriesTitle} · ${episodeLabel(item)} · ${item.episodeTitle}` })), index: index - offset }); }} />}
  </section>;
}
export function episodeLabel(episode: MediaEpisode) {
  const season = episode.seasonNumber === null ? "" : `S${String(episode.seasonNumber).padStart(2, "0")}`;
  return episode.episodeNumber === null ? episode.kind === "audio" ? "Audio" : "Vidéo" : `${season} E${String(episode.episodeNumber).padStart(2, "0")}`.trim();
}
function WatchProgress({ record }: { record?: WatchRecord }) {
  const percentage = watchPercentage(record);
  return <span className={`sly-media-progress ${record?.completed ? "is-complete" : ""}`}><span><b>{record?.completed ? "Vu" : canResume(record) ? formatMediaTime(record?.position || 0) : "Non vu"}</b><small>{percentage} %</small></span><span className="sly-media-progress-track" role="progressbar" aria-label="Visionnage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}><i style={{ width: `${percentage}%` }} /></span></span>;
}
