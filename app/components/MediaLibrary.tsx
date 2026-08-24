"use client";

import {
  ChevronDown,
  CirclePlay,
  Clock3,
  Film,
  FolderCog,
  FolderLock,
  FolderOpen,
  Library,
  LoaderCircle,
  LockKeyhole,
  Maximize2,
  Minimize2,
  Music2,
  ScanSearch,
  Search,
  ShieldCheck,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  buildMediaLibrary,
  flattenPlayableSeries,
  type MediaEpisode,
  type TorrentMediaGroup,
} from "../../lib/media-library";
import "./media-library.css";

export type MediaBridge = Pick<NonNullable<Window["secuTorrent"]>, "openMedia" | "verifyAndScan" | "chooseDownloadDirectory" | "openDownloadDirectory" | "openTorrentDirectory">;

type PlayerSource = {
  episode: MediaEpisode;
  url: string;
  mimeType: string;
  expiresAt: string;
  audioAdapted: boolean;
  audioCodec: string | null;
  audioLanguage: string | null;
};

export type MediaLibraryProps = {
  torrents: readonly SecuTorrentTorrent[];
  bridge?: MediaBridge;
  initialQuery?: string;
  downloadDirectory?: string;
  onDirectoryChanged?: () => void;
  onNotice?: (tone: "success" | "error" | "info", message: string) => void;
  className?: string;
};

export type VideoThumbnailProps = {
  episode: MediaEpisode;
  getBridge: () => MediaBridge;
};

const numberFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const ratioFormatSmall = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const ratioFormatTiny = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) { current /= 1024; unit += 1; }
  return `${numberFormat.format(current)} ${units[unit]}`;
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value % 60).toString().padStart(2, "0");
  const minutes = Math.floor(value / 60) % 60;
  const hours = Math.floor(value / 3600);
  return hours > 0 ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function formatRatio(value: number) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio <= 0) return "0";
  if (ratio < .0001) return "< 0,0001";
  if (ratio < .01) return ratioFormatTiny.format(ratio);
  if (ratio < .1) return ratioFormatSmall.format(ratio);
  return numberFormat.format(ratio);
}

function episodeOrdinal(episode: MediaEpisode) {
  if (episode.episodeNumber === null) return episode.kind === "audio" ? "Piste" : "Film";
  return `E${String(episode.episodeNumber).padStart(2, "0")}`;
}

function readableError(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Flux média indisponible.";
}

function directoryLabel(value: string) {
  return value.replace(/[\\/]+$/u, "").split(/[\\/]/u).filter(Boolean).at(-1) || "Dossier local";
}

function isLocalMediaUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "secutorrent-media:"
      && parsed.hostname === "stream"
      && /^[A-Za-z0-9_-]{43}$/u.test(parsed.pathname.slice(1))
      && parsed.username === ""
      && parsed.password === ""
      && parsed.port === ""
      && parsed.search === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}

function isFrenchLanguage(value: string | null) {
  return new Set(["fr", "fre", "fra", "french"]).has(String(value || "").toLowerCase());
}

function releaseSource(source: PlayerSource | null) {
  if (source?.url.startsWith("blob:")) URL.revokeObjectURL(source.url);
}

let activeThumbnailLoads = 0;
const thumbnailQueue: Array<() => void> = [];

function pumpThumbnailQueue() {
  while (activeThumbnailLoads < 2 && thumbnailQueue.length) thumbnailQueue.shift()?.();
}

function scheduleThumbnail<T>(task: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    thumbnailQueue.push(() => {
      activeThumbnailLoads += 1;
      task().then(resolve, reject).finally(() => { activeThumbnailLoads -= 1; pumpThumbnailQueue(); });
    });
    pumpThumbnailQueue();
  });
}

export function MediaLibraryView({ torrents, bridge, initialQuery = "", downloadDirectory = "", onDirectoryChanged, onNotice, className = "" }: MediaLibraryProps) {
  const [query, setQuery] = useState(initialQuery);
  const [source, setSource] = useState<PlayerSource | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [collectionAction, setCollectionAction] = useState<string | null>(null);
  const [directoryAction, setDirectoryAction] = useState<"choose" | "open" | null>(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const playerFrameRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const fullLibrary = useMemo(() => buildMediaLibrary(torrents), [torrents]);
  const visibleLibrary = useMemo(() => buildMediaLibrary(torrents, query), [query, torrents]);
  const visibleCount = useMemo(() => visibleLibrary.reduce((total, torrent) => total + torrent.total, 0), [visibleLibrary]);

  const playlist = useMemo(() => {
    if (!source) return [];
    const torrent = fullLibrary.find((group) => group.torrentId === source.episode.torrentId);
    const series = torrent?.series.find((group) => group.title === source.episode.seriesTitle);
    return torrent && series ? flattenPlayableSeries(torrent, series.key) : [];
  }, [fullLibrary, source]);
  const playlistIndex = source ? playlist.findIndex((episode) => episode.key === source.episode.key) : -1;
  const previousEpisode = playlistIndex > 0 ? playlist[playlistIndex - 1] : null;
  const nextEpisode = playlistIndex >= 0 && playlistIndex < playlist.length - 1 ? playlist[playlistIndex + 1] : null;

  const activeBridge = useCallback(() => {
    const candidate = bridge ?? (typeof window !== "undefined" ? window.secuTorrent : undefined);
    if (!candidate) throw new Error("Interface média indisponible.");
    return candidate;
  }, [bridge]);

  const closePlayer = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    setFallbackFullscreen(false);
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    setSource((current) => { releaseSource(current); return null; });
    setPlaying(false);
    setError("");
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  }, []);

  const openEpisode = useCallback(async (episode: MediaEpisode, trigger?: HTMLElement | null) => {
    if (!episode.playable) {
      const message = "Lecture bloquée · fichier incomplet ou non validé.";
      setError(message);
      onNotice?.("error", message);
      return;
    }
    if (trigger) returnFocusRef.current = trigger;
    setLoadingKey(episode.key);
    setError("");
    try {
      const result = await activeBridge().openMedia({ id: episode.torrentId, fileIndex: episode.fileIndex, purpose: "playback" });
      if (!result?.url || !isLocalMediaUrl(result.url)) throw new Error("Flux local refusé.");
      setCurrentTime(0);
      setDuration(0);
      setPlaying(false);
      setSource((current) => {
        releaseSource(current);
        return {
          episode,
          url: result.url,
          mimeType: result.mimeType,
          expiresAt: result.expiresAt,
          audioAdapted: result.audioAdapted === true,
          audioCodec: result.audioCodec ?? null,
          audioLanguage: result.audioLanguage ?? null,
        };
      });
    } catch (caught) {
      const message = readableError(caught);
      setError(message);
      onNotice?.("error", message);
    } finally {
      setLoadingKey(null);
    }
  }, [activeBridge, onNotice]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !source || dialog.open) return;
    dialog.showModal();
    const frame = window.requestAnimationFrame(() => dialog.querySelector<HTMLElement>("[data-player-close]")?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [source]);

  useEffect(() => {
    const onFullscreenChange = () => {
      const frame = playerFrameRef.current;
      setNativeFullscreen(Boolean(frame && document.fullscreenElement === frame));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!fallbackFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [fallbackFullscreen]);

  useEffect(() => () => releaseSource(source), [source]);

  async function toggleFullscreen() {
    const frame = playerFrameRef.current;
    if (!frame) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (fallbackFullscreen) { setFallbackFullscreen(false); return; }
    try {
      if (typeof frame.requestFullscreen !== "function") throw new Error("Fullscreen indisponible");
      await frame.requestFullscreen();
    } catch {
      setFallbackFullscreen(true);
    }
  }

  function handlePlay(event: ReactMouseEvent<HTMLButtonElement>, episode: MediaEpisode) {
    void openEpisode(episode, event.currentTarget);
  }

  function handlePlaybackError() {
    setPlaying(false);
    setError("Codec audio ou vidéo non pris en charge.");
  }

  async function runCollectionValidation(group: TorrentMediaGroup) {
    const key = `validate-${group.torrentId}`;
    setCollectionAction(key);
    setError("");
    try {
      await activeBridge().verifyAndScan(group.torrentId);
      onNotice?.("success", `Vérification et analyse terminées · ${group.torrentName}`);
    } catch (caught) {
      const message = readableError(caught);
      setError(message);
      onNotice?.("error", message);
    } finally {
      setCollectionAction(null);
    }
  }

  async function openTorrentDirectory(group: TorrentMediaGroup) {
    setCollectionAction(`folder-${group.torrentId}`);
    setError("");
    try {
      await activeBridge().openTorrentDirectory(group.torrentId);
    } catch (caught) {
      const message = readableError(caught);
      setError(message);
      onNotice?.("error", message);
    } finally { setCollectionAction(null); }
  }

  async function chooseDownloadDirectory() {
    setDirectoryAction("choose");
    setError("");
    try {
      const result = await activeBridge().chooseDownloadDirectory();
      if (!result.canceled) {
        onNotice?.("success", "Bibliothèque par défaut modifiée.");
        onDirectoryChanged?.();
      }
    } catch (caught) {
      const message = readableError(caught);
      setError(message);
      onNotice?.("error", message);
    } finally { setDirectoryAction(null); }
  }

  async function openDefaultDownloadDirectory() {
    setDirectoryAction("open");
    setError("");
    try {
      await activeBridge().openDownloadDirectory();
    } catch (caught) {
      const message = readableError(caught);
      setError(message);
      onNotice?.("error", message);
    } finally { setDirectoryAction(null); }
  }

  const expanded = nativeFullscreen || fallbackFullscreen;

  return <section className={`sly-media-library ${className}`.trim()} data-testid="media-library" aria-labelledby="sly-media-library-title">
    <header className="sly-media-hero">
      <div className="sly-media-hero-copy">
        <span className="sly-media-eyebrow"><Library size={14} /> BIBLIOTHÈQUE PAR DÉFAUT</span>
        <h1 id="sly-media-library-title">Médiathèque</h1>
        <p>Classement par torrent, série et saison. Lecture après validation Defender.</p>
      </div>
      <div className="sly-media-hero-art" aria-hidden="true"><img src="./slyorus.png" alt="" /><span><ShieldCheck size={13} /> fichiers validés</span></div>
    </header>

    <div className="sly-media-toolbar">
      <label className="sly-media-search"><Search size={17} /><span className="sly-media-visually-hidden">Rechercher dans la médiathèque</span><input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="Série, saison, épisode, torrent…" aria-label="Rechercher dans la médiathèque" /></label>
      <div className="sly-media-folder-tools">
        <span className="sly-media-folder-label" title={downloadDirectory}><FolderLock size={15} /><span><small>NOUVEAUX TORRENTS</small><b>{directoryLabel(downloadDirectory)}</b></span></span>
        <button type="button" disabled={directoryAction !== null} onClick={() => void chooseDownloadDirectory()} title="Changer le dossier des nouveaux téléchargements">{directoryAction === "choose" ? <LoaderCircle className="sly-media-spin" size={15} /> : <FolderCog size={15} />} Changer</button>
        <button type="button" disabled={directoryAction !== null} onClick={() => void openDefaultDownloadDirectory()} title="Ouvrir le dossier dans l’Explorateur Windows">{directoryAction === "open" ? <LoaderCircle className="sly-media-spin" size={15} /> : <FolderOpen size={15} />} Ouvrir</button>
      </div>
      <div className="sly-media-result" role="status" aria-live="polite"><b>{visibleCount}</b><span>média{visibleCount > 1 ? "s" : ""}</span><i /> <b>{visibleLibrary.reduce((total, group) => total + group.playable, 0)}</b><span>prêt{visibleLibrary.reduce((total, group) => total + group.playable, 0) > 1 ? "s" : ""}</span></div>
    </div>

    {error && !source && <div className="sly-media-alert" role="alert"><LockKeyhole size={16} /> {error}<button type="button" onClick={() => setError("")} aria-label="Fermer l’alerte"><X size={14} /></button></div>}

    {visibleLibrary.length ? <div className="sly-media-torrents">
      {visibleLibrary.map((torrent) => <TorrentCollection key={torrent.key} group={torrent} loadingKey={loadingKey} collectionAction={collectionAction} onPlay={handlePlay} onValidate={() => void runCollectionValidation(torrent)} onOpenDirectory={() => void openTorrentDirectory(torrent)} getBridge={activeBridge} />)}
    </div> : <div className="sly-media-empty">
      <span><FolderLock size={28} /></span>
      <h2>{query ? "Aucun média correspondant" : "Aucun média détecté"}</h2>
      <p>{query ? "Aucun nom, torrent, saison ou épisode correspondant." : "Audio et vidéo validés par Defender uniquement."}</p>
    </div>}

    <dialog ref={dialogRef} className="sly-media-dialog" aria-labelledby="sly-media-player-title" onCancel={(event) => {
      if (fallbackFullscreen) { event.preventDefault(); setFallbackFullscreen(false); }
      else { event.preventDefault(); closePlayer(); }
    }} onClose={() => {
      setFallbackFullscreen(false);
      setSource((current) => { releaseSource(current); return null; });
      setPlaying(false);
      setError("");
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    }}>
      {source && <div ref={playerFrameRef} className={`sly-media-player ${fallbackFullscreen ? "is-fallback-fullscreen" : ""}`}>
        <header>
          <div>
            <span className="sly-media-clean"><i /><ShieldCheck size={12} /> FICHIER VALIDÉ</span>
            <h2 id="sly-media-player-title">{source.episode.episodeTitle}</h2>
            <p>{source.episode.seriesTitle} · {source.episode.seasonNumber === null ? "Hors-saison" : `Saison ${source.episode.seasonNumber}`} · {episodeOrdinal(source.episode)}</p>
          </div>
          <div className="sly-media-window-actions">
            <button type="button" onClick={() => void toggleFullscreen()} aria-label={expanded ? "Quitter le plein écran" : "Activer le plein écran"} title={expanded ? "Quitter le plein écran" : "Plein écran"}>{expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
            <button type="button" onClick={closePlayer} aria-label="Fermer le lecteur" data-player-close><X size={19} /></button>
          </div>
        </header>

        <div className={`sly-media-stage ${source.episode.kind}`}>
          {source.episode.kind === "video" ? <>
            {/* Les fichiers locaux n’ont pas nécessairement de piste de sous-titres correspondante. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video src={source.url} controls autoPlay playsInline preload="metadata" controlsList="nodownload" aria-label={`Lecture vidéo de ${source.episode.episodeTitle}`} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onCanPlay={() => setError("")} onError={handlePlaybackError} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} />
          </> : <div className="sly-media-audio-stage">
            <div className="sly-media-audio-art"><img src="./slyorus.png" alt="" /><span><Music2 size={26} /></span></div>
            <div><span>AUDIO LOCAL</span><h3>{source.episode.episodeTitle}</h3><p>{source.episode.fileName}</p></div>
            {/* Les pistes locales n’ont pas nécessairement de transcription correspondante. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio src={source.url} controls autoPlay preload="metadata" controlsList="nodownload" aria-label={`Lecture audio de ${source.episode.episodeTitle}`} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onCanPlay={() => setError("")} onError={handlePlaybackError} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} />
          </div>}
          <span className="sly-media-watermark"><img src="./slyorus.png" alt="" /> Slyorent</span>
        </div>

        <div className="sly-media-native-meta" aria-live="polite">
          <span className={playing ? "is-playing" : ""}>{source.episode.kind === "audio" ? <Music2 size={14} /> : <Film size={14} />} {source.episode.kind === "audio" ? "Audio" : "Vidéo + audio"} · {playing ? "Lecture" : "Pause"}</span>
          <span><Clock3 size={14} /> {formatTime(currentTime)} / {formatTime(duration)}</span>
          <span>{source.audioAdapted ? `Audio ${source.audioCodec || "AAC"} intégré${isFrenchLanguage(source.audioLanguage) ? " · FR" : ""}` : (source.mimeType || source.episode.extension.toUpperCase())} · {formatBytes(source.episode.length)}</span>
        </div>

        <footer>
          <div className="sly-media-episode-nav">
            <button type="button" disabled={!previousEpisode || loadingKey !== null} onClick={() => previousEpisode && void openEpisode(previousEpisode)} aria-label="Épisode précédent"><SkipBack size={17} /><span>Précédent</span></button>
            <button type="button" disabled={!nextEpisode || loadingKey !== null} onClick={() => nextEpisode && void openEpisode(nextEpisode)} aria-label="Épisode suivant"><span>Suivant</span><SkipForward size={17} /></button>
          </div>
          <div className="sly-media-source-meta"><LockKeyhole size={14} /><span>Flux local temporaire · source distante : 0</span></div>
        </footer>
        {error && <div className="sly-media-player-error" role="alert">{error}</div>}
      </div>}
    </dialog>
  </section>;
}

function TorrentCollection({ group, loadingKey, collectionAction, onPlay, onValidate, onOpenDirectory, getBridge }: { group: TorrentMediaGroup; loadingKey: string | null; collectionAction: string | null; onPlay: (event: ReactMouseEvent<HTMLButtonElement>, episode: MediaEpisode) => void; onValidate: () => void; onOpenDirectory: () => void; getBridge: () => MediaBridge }) {
  const [expanded, setExpanded] = useState(false);
  const verifyBusy = collectionAction === `validate-${group.torrentId}` || ["verifying", "queued-verification"].includes(group.status);
  const folderBusy = collectionAction === `folder-${group.torrentId}`;
  const actionBusy = collectionAction !== null;
  const torrentComplete = group.percentDone >= .999999;
  return <article className="sly-media-torrent">
    <header>
      <button type="button" className="sly-media-collection-toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
        <span className="sly-media-torrent-icon"><Library size={18} /></span>
        <span className="sly-media-collection-copy"><span>TORRENT</span><strong>{group.torrentName}</strong><small>{group.series.length} série{group.series.length > 1 ? "s" : ""} · {group.total} média{group.total > 1 ? "s" : ""}</small></span>
        <span className="sly-media-ready-count"><ShieldCheck size={13} /> prêts {group.playable}/{group.total}</span>
        <ChevronDown className="sly-media-collection-chevron" size={17} />
      </button>
      <div className="sly-media-collection-actions">
        <button type="button" disabled={actionBusy || verifyBusy || !torrentComplete} onClick={onValidate} title={torrentComplete ? "Vérifier les pièces puis analyser avec Microsoft Defender" : "Torrent incomplet"}>{verifyBusy ? <LoaderCircle className="sly-media-spin" size={15} /> : <ScanSearch size={15} />}<span>Vérifier et analyser</span></button>
        <button type="button" disabled={actionBusy} onClick={onOpenDirectory} title="Ouvrir le dossier de ce torrent">{folderBusy ? <LoaderCircle className="sly-media-spin" size={15} /> : <FolderOpen size={15} />}<span>Dossier</span></button>
      </div>
    </header>
    {expanded && <div className="sly-media-series-list">
      {group.series.map((series) => <details className="sly-media-series" key={series.key}>
        <summary><span><ChevronDown size={15} /><span><small>SÉRIE / FILM</small><strong>{series.title}</strong></span></span><em>{series.seasons.length} saison{series.seasons.length > 1 ? "s" : ""}</em></summary>
        <div className="sly-media-seasons">
          {series.seasons.map((season) => <details className="sly-media-season" key={season.key}>
            <summary><span><ChevronDown size={15} /><b>{season.label}</b></span><small>{season.episodes.length} épisode{season.episodes.length > 1 ? "s" : ""}</small></summary>
            <div className="sly-media-episodes">
              {season.episodes.map((episode) => <article className={`sly-media-episode ${episode.playable ? "is-playable" : "is-locked"}`} key={episode.key}>
                <span className="sly-media-ordinal">{episodeOrdinal(episode)}</span>
                <VideoThumbnail episode={episode} getBridge={getBridge} />
                <div><h4>{episode.episodeTitle}</h4><p title={episode.fileName}>{episode.fileName}</p><span>{formatBytes(episode.length)} · {episode.kind === "audio" ? "Audio" : "Vidéo"} · ratio {formatRatio(episode.uploadRatio)}</span></div>
                <span className={`sly-media-scan ${episode.playable ? "clean" : "locked"}`}>{episode.playable ? <><ShieldCheck size={12} /> Validé</> : <><LockKeyhole size={12} /> {episode.completed ? "Scan requis" : "Incomplet"}</>}</span>
                <button type="button" disabled={!episode.playable || loadingKey !== null} onClick={(event) => onPlay(event, episode)} aria-label={`Lire ${episode.episodeTitle}`} title={episode.playable ? `Lire ${episode.episodeTitle}` : "Fichier incomplet ou non validé"}>{loadingKey === episode.key ? <LoaderCircle className="sly-media-spin" size={18} /> : <CirclePlay size={21} />}</button>
              </article>)}
            </div>
          </details>)}
        </div>
      </details>)}
    </div>}
  </article>;
}

export function VideoThumbnail({ episode, getBridge }: VideoThumbnailProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [state, setState] = useState<"fallback" | "loading" | "seeking" | "ready" | "error">("fallback");

  useEffect(() => {
    const element = rootRef.current;
    if (!element || episode.kind !== "video" || !episode.playable) return;
    const Observer = globalThis.IntersectionObserver;
    if (typeof Observer !== "function") {
      const timer = globalThis.setTimeout(() => setVisible(true), 0);
      return () => globalThis.clearTimeout(timer);
    }
    const observer = new Observer((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "120px", threshold: .05 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [episode.kind, episode.playable]);

  useEffect(() => {
    if (!visible || episode.kind !== "video" || !episode.playable || sourceUrl) return;
    let cancelled = false;
    const timer = window.setTimeout(() => setState("loading"), 0);
    void scheduleThumbnail(() => {
      if (cancelled) throw new DOMException("Chargement de vignette annulé.", "AbortError");
      return getBridge().openMedia({ id: episode.torrentId, fileIndex: episode.fileIndex, purpose: "thumbnail" });
    })
      .then((result) => {
        if (cancelled) { if (result?.url?.startsWith("blob:")) URL.revokeObjectURL(result.url); return; }
        if (!result?.url || !isLocalMediaUrl(result.url)) throw new Error("URL de vignette non locale refusée.");
        setSourceUrl(result.url);
      })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [episode.fileIndex, episode.kind, episode.playable, episode.torrentId, getBridge, sourceUrl, visible]);

  useEffect(() => () => {
    const video = videoRef.current;
    if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    if (sourceUrl.startsWith("blob:")) URL.revokeObjectURL(sourceUrl);
  }, [sourceUrl]);

  function failThumbnail() {
    const video = videoRef.current;
    if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    setState("error");
  }

  return <div ref={rootRef} className={`sly-media-thumbnail ${state === "ready" ? "is-ready" : "is-fallback"}`} data-testid="video-thumbnail" aria-hidden="true">
    {sourceUrl && state !== "error" && <video ref={videoRef} src={sourceUrl} muted playsInline preload="metadata" tabIndex={-1} onLoadedMetadata={(event) => {
      const video = event.currentTarget;
      video.pause();
      const upperBound = Math.max(0, video.duration - .25);
      const target = Math.min(upperBound, Math.min(45, Math.max(8, video.duration * .1)));
      if (!Number.isFinite(target) || target < 0) { failThumbnail(); return; }
      setState("seeking");
      try { video.currentTime = target; } catch { failThumbnail(); }
    }} onSeeked={(event) => { event.currentTarget.pause(); setState("ready"); }} onError={failThumbnail} />}
    <span className="sly-media-thumbnail-fallback">{episode.kind === "audio" ? <Music2 size={19} /> : <Film size={19} />}</span>
    <span className="sly-media-thumbnail-label">{episode.seasonNumber === null ? episodeOrdinal(episode) : `S${String(episode.seasonNumber).padStart(2, "0")} · ${episodeOrdinal(episode)}`}</span>
    {state === "loading" || state === "seeking" ? <LoaderCircle className="sly-media-thumbnail-loader sly-media-spin" size={15} /> : null}
  </div>;
}

export default MediaLibraryView;
