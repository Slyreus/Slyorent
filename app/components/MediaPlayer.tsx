"use client";

import { Captions, Cast, CirclePlay, Clock3, LoaderCircle, LockKeyhole, Maximize2, Minimize2, Music2, RotateCcw, ShieldCheck, SkipBack, SkipForward, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";
import type { MediaEpisode } from "../../lib/media-library";
import { canResume, defaultSubtitleTrack, formatMediaTime, trackLabel, trackLanguage, type MediaAccess, type MediaPlaybackSession, type WatchRecord } from "../../lib/media-playback";
import type { MediaBridge } from "./MediaLibrary";

type Props = {
  episode: MediaEpisode;
  initialRecord?: WatchRecord;
  session: MediaPlaybackSession;
  getBridge: () => MediaBridge;
  previous?: MediaEpisode;
  next?: MediaEpisode;
  onSelect: (episode: MediaEpisode) => void;
  onClose: () => void;
  onProgress: (key: string, record: WatchRecord) => void;
  onCast?: (options: { position: number; audioTrack?: number; subtitleTrack: number | null }) => void;
};

export function MediaPlayer({ episode, initialRecord, session, getBridge, previous, next, onSelect, onClose, onProgress, onCast }: Props) {
  const [source, setSource] = useState<MediaAccess | null>(null);
  const [resumePrompt, setResumePrompt] = useState(canResume(initialRecord));
  const [loading, setLoading] = useState(true);
  const [preparation, setPreparation] = useState<SecuTorrentMediaPreparation | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(initialRecord?.position || 0);
  const [duration, setDuration] = useState(initialRecord?.duration || 0);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [nextReady, setNextReady] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false);
  const [subtitleIndex, setSubtitleIndex] = useState<number | null>(null);
  const [audioIndex, setAudioIndex] = useState<number | null>(null);
  const [subtitle, setSubtitle] = useState<{ index: number; url: string; label: string; language: string } | null>(null);
  const [subtitleError, setSubtitleError] = useState("");
  const [subtitleAttempt, setSubtitleAttempt] = useState(0);
  const [captionLines, setCaptionLines] = useState<string[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const sourceRef = useRef<MediaAccess | null>(null);
  const trackRef = useRef<HTMLTrackElement | null>(null);
  const audioSelection = useRef<number | undefined>(undefined);
  const subtitleSelection = useRef<number | null>(null);
  const automaticSubtitles = useRef(true);
  const nativeFullscreen = useRef(false);
  const alive = useRef(false);
  const initialized = useRef(false);
  const recovering = useRef(false);
  const recoveries = useRef(0);
  const lastRecovery = useRef(0);
  const lastSave = useRef(0);
  const lastSavedPosition = useRef(-1);
  const startPosition = useRef<number | null>(canResume(initialRecord) ? null : 0);
  const wantsPlayback = useRef(true);
  const playbackSettings = useRef({ volume: 1, muted: false, rate: 1 });
  const checkpoint = useRef({ position: initialRecord?.position || 0, duration: initialRecord?.duration || 0, completed: initialRecord?.completed || false });
  const attachMedia = useCallback((node: HTMLMediaElement | null) => { mediaRef.current = node; }, []);
  const attachTrack = useCallback((node: HTMLTrackElement | null) => {
    trackRef.current = node;
    if (!node) return;
    const updateCues = () => setCaptionLines(Array.from(node.track.activeCues || []).map((cue) => (cue as VTTCue).getCueAsHTML().textContent || "").filter(Boolean));
    const loaded = () => { node.track.mode = nativeFullscreen.current ? "showing" : "hidden"; updateCues(); };
    const failed = () => setSubtitleError("Chargement des sous-titres impossible.");
    node.addEventListener("load", loaded);
    node.addEventListener("error", failed);
    node.track.addEventListener("cuechange", updateCues);
    if (node.readyState === 2) loaded();
    return () => { node.removeEventListener("load", loaded); node.removeEventListener("error", failed); node.track.removeEventListener("cuechange", updateCues); if (trackRef.current === node) trackRef.current = null; };
  }, []);
  const acceptSource = useCallback((access: MediaAccess) => {
    sourceRef.current = access;
    setSource(access);
    setAudioIndex(access.selectedAudioTrack ?? null);
    setPreparation(null);
    if (automaticSubtitles.current) {
      const chosen = defaultSubtitleTrack(access.subtitleTracks || [], access.audioLanguage);
      if (chosen !== subtitleSelection.current) { setSubtitle(null); setSubtitleError(""); setCaptionLines([]); }
      subtitleSelection.current = chosen;
      setSubtitleIndex(chosen);
    }
  }, []);

  const save = useCallback((ended = false) => {
    const media = mediaRef.current;
    if (!initialized.current || !media || !Number.isFinite(media.duration) || media.duration <= 0 || media.seeking) return;
    const record = {
      position: Math.max(0, Math.min(media.currentTime, media.duration)),
      duration: media.duration,
      completed: checkpoint.current.completed || ended,
      updatedAt: Date.now(),
    };
    if (!Number.isFinite(record.position)) return;
    checkpoint.current = record;
    if (!ended && Math.abs(lastSavedPosition.current - record.position) < .1) return;
    lastSave.current = Date.now();
    lastSavedPosition.current = record.position;
    onProgress(episode.watchKey, record);
    void getBridge().savePlayback({ id: episode.torrentId, fileIndex: episode.fileIndex, ...record }).then((saved) => {
      onProgress(saved.key, saved);
      if (alive.current) setSaveError("");
    }).catch(() => {
      lastSavedPosition.current = -1;
      if (alive.current) setSaveError("Position non enregistrée. Nouvelle tentative à la prochaine pause.");
    });
  }, [episode, getBridge, onProgress]);

  useLayoutEffect(() => () => save(), [save]);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const dialog = dialogRef.current;
    const frame = frameRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    dialog?.querySelector<HTMLElement>("[data-player-close]")?.focus();
    void session.take(episode).then((access) => {
      if (cancelled) { session.release(access); return; }
      acceptSource(access);
    }).catch((caught: unknown) => {
      if (!cancelled) { setError(caught instanceof Error ? caught.message : "Média indisponible."); setLoading(false); }
    });
    return () => {
      cancelled = true;
      session.cancelOpen(episode.key);
      save();
      alive.current = false;
      initialized.current = false;
      const media = mediaRef.current;
      if (media) { media.pause(); media.removeAttribute("src"); media.load(); }
      if (sourceRef.current) session.release(sourceRef.current);
      if (document.fullscreenElement === frame) void document.exitFullscreen().catch(() => undefined);
    };
  }, [episode, session, save, acceptSource]);

  const recover = useCallback(async (automatic: boolean, audioTrack?: number) => {
    if (!alive.current || recovering.current) return;
    if (automatic && recoveries.current >= 2) { setError("Lecture interrompue. Réessayer au même endroit."); setLoading(false); setBuffering(false); return; }
    if (automatic) recoveries.current += 1; else recoveries.current = 0;
    lastRecovery.current = Date.now();
    recovering.current = true;
    if (audioTrack !== undefined) { audioSelection.current = audioTrack; setAudioIndex(audioTrack); }
    save();
    const media = mediaRef.current;
    if (initialized.current && media) {
      startPosition.current = Number.isFinite(media.currentTime) ? media.currentTime : checkpoint.current.position;
      playbackSettings.current = { volume: media.volume, muted: media.muted, rate: media.playbackRate };
    }
    initialized.current = false;
    media?.pause();
    setPlaying(false);
    setPreparation(null);
    setLoading(true);
    setError("");
    try {
      const access = await session.reopen(episode, audioSelection.current ?? sourceRef.current?.selectedAudioTrack ?? undefined);
      if (!alive.current) { session.release(access); return; }
      if (sourceRef.current) session.release(sourceRef.current);
      acceptSource(access);
    } catch (caught) {
      if (alive.current) { setError(caught instanceof Error ? caught.message : "Média indisponible."); setLoading(false); }
    } finally { recovering.current = false; }
  }, [episode, session, save, acceptSource]);

  const subtitleTrack = source?.subtitleTracks?.find((track) => track.index === subtitleIndex);
  useEffect(() => {
    if (subtitleIndex === null || !subtitleTrack) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    void session.subtitle(episode, subtitleIndex).then((vtt) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
      setSubtitle({ index: subtitleIndex, url: objectUrl, label: trackLabel(subtitleTrack), language: trackLanguage(subtitleTrack.language) });
      setSubtitleError("");
    }).catch((caught: unknown) => {
      if (!cancelled) setSubtitleError(caught instanceof Error ? caught.message : "Sous-titres indisponibles.");
    });
    return () => { cancelled = true; session.cancelSubtitles(episode.key); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [episode, session, subtitleIndex, subtitleTrack, subtitleAttempt]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !subtitle) return;
    const changed = () => {
      const track = trackRef.current;
      if (track?.readyState === 2 && initialized.current && track.track.mode === "disabled") {
        automaticSubtitles.current = false;
        subtitleSelection.current = null;
        setSubtitleIndex(null);
        setSubtitle(null);
        setCaptionLines([]);
      } else if (track?.readyState === 2 && track.track.mode === "showing" && !nativeFullscreen.current) {
        track.track.mode = "hidden";
      }
    };
    media.textTracks.addEventListener("change", changed);
    return () => media.textTracks.removeEventListener("change", changed);
  }, [source, subtitle]);

  function chooseSubtitle(value: string) {
    automaticSubtitles.current = false;
    const index = value === "" ? null : Number(value);
    subtitleSelection.current = index;
    setSubtitleIndex(index);
    setSubtitle(null);
    setSubtitleError("");
    setCaptionLines([]);
  }

  useEffect(() => {
    if (!loading) return;
    let stopped = false;
    let polling = false;
    const poll = async () => {
      if (stopped || polling) return;
      polling = true;
      try { const progress = await session.progress(episode.key); if (!stopped && progress) setPreparation(progress); }
      catch { /* L'ouverture conserve son propre diagnostic d'erreur. */ }
      finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 750);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [loading, episode.key, session]);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    let checking = false;
    const renew = async () => {
      if (checking || cancelled) return;
      checking = true;
      void session.keepWarm();
      try { await getBridge().renewMedia(source.url); }
      catch { if (!cancelled) await recover(true); }
      finally { checking = false; }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void renew(); };
    const timer = window.setInterval(() => void renew(), 60_000);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", onVisible); window.removeEventListener("pageshow", onVisible); document.removeEventListener("visibilitychange", onVisible); };
  }, [source, getBridge, session, recover]);

  const nextKey = next?.key;
  const nextRef = useRef(next);
  useEffect(() => { nextRef.current = next; }, [next]);
  useEffect(() => {
    if (!playing || !nextKey) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const upcoming = nextRef.current;
      if (upcoming) void session.prewarm(upcoming).then((ready) => { if (!cancelled) setNextReady(ready); });
    }, 5_000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [playing, nextKey, session]);

  useEffect(() => {
    if (!buffering || !playing || !source) return;
    const timer = window.setTimeout(() => { if (wantsPlayback.current && !mediaRef.current?.seeking) void recover(true); }, 12_000);
    return () => window.clearTimeout(timer);
  }, [buffering, playing, source, recover]);
  useEffect(() => {
    const changed = () => {
      nativeFullscreen.current = !!document.fullscreenElement && document.fullscreenElement === mediaRef.current;
      const track = trackRef.current;
      if (track?.readyState === 2 && subtitleSelection.current !== null) track.track.mode = nativeFullscreen.current ? "showing" : "hidden";
      setFullscreen(document.fullscreenElement === frameRef.current);
    };
    const leaving = () => save();
    document.addEventListener("fullscreenchange", changed);
    window.addEventListener("pagehide", leaving);
    window.addEventListener("beforeunload", leaving);
    return () => { document.removeEventListener("fullscreenchange", changed); window.removeEventListener("pagehide", leaving); window.removeEventListener("beforeunload", leaving); };
  }, [save]);

  function initialize(media: HTMLMediaElement) {
    if (initialized.current || startPosition.current === null || media.readyState < 1) return;
    if (!Number.isFinite(media.duration) || media.duration <= 0) { setError("Durée du média indisponible."); setLoading(false); return; }
    const target = Math.min(startPosition.current, Math.max(0, media.duration - .05));
    const settings = playbackSettings.current;
    media.volume = settings.volume; media.muted = settings.muted; media.playbackRate = settings.rate;
    media.currentTime = target;
    setPosition(target);
    initialized.current = true;
    if (wantsPlayback.current) void media.play().catch((caught: unknown) => {
      if (alive.current && caught instanceof DOMException && caught.name === "NotAllowedError") setLoading(false);
    });
    else { setLoading(false); setBuffering(false); }
  }

  function chooseStart(value: number) {
    startPosition.current = value;
    setResumePrompt(false);
    if (mediaRef.current) initialize(mediaRef.current);
  }

  function onTime(event: SyntheticEvent<HTMLMediaElement>) {
    const media = event.currentTarget;
    if (!initialized.current || media.seeking || !Number.isFinite(media.currentTime)) return;
    setPosition(media.currentTime);
    if (!media.paused && media.readyState >= 3 && Date.now() - lastRecovery.current > 30_000) recoveries.current = 0;
    checkpoint.current.position = media.currentTime;
    if (Date.now() - lastSave.current >= 5_000) save();
  }

  async function onMediaError() {
    const code = mediaRef.current?.error?.code;
    if (!sourceRef.current || !code || code === 1 || recovering.current) return;
    try { await getBridge().renewMedia(sourceRef.current.url); }
    catch { if (alive.current) void recover(true); return; }
    if (!alive.current) return;
    if (code === 2) { void recover(true); return; }
    setLoading(false); setBuffering(false); setPlaying(false);
    setError(code === 3 ? "Décodage interrompu. Réessayer au même endroit." : "Format audio ou vidéo non pris en charge.");
  }

  const events = {
    onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => { setDuration(event.currentTarget.duration); initialize(event.currentTarget); },
    onCanPlay: (event: SyntheticEvent<HTMLMediaElement>) => { initialize(event.currentTarget); if (initialized.current) { setLoading(false); setBuffering(false); } },
    onPlay: () => { wantsPlayback.current = true; setPlaying(true); },
    onPlaying: () => { setPlaying(true); setLoading(false); setBuffering(false); setError(""); },
    onPause: () => { if (initialized.current && !mediaRef.current?.error) { wantsPlayback.current = false; setPlaying(false); save(); } },
    onEnded: () => { save(true); setPlaying(false); wantsPlayback.current = false; },
    onWaiting: () => setBuffering(true),
    onStalled: () => setBuffering(true),
    onTimeUpdate: onTime,
    onSeeked: () => { if (initialized.current) { save(); setBuffering(false); } },
    onError: () => void onMediaError(),
  };

  async function toggleFullscreen() {
    if (document.fullscreenElement) { await document.exitFullscreen().catch(() => undefined); return; }
    if (fallbackFullscreen) { setFallbackFullscreen(false); return; }
    try { await frameRef.current?.requestFullscreen(); }
    catch { setFallbackFullscreen(true); }
  }

  function close() { save(); onClose(); }
  function select(item: MediaEpisode) { save(); onSelect(item); }
  const expanded = fullscreen || fallbackFullscreen;
  const preparationLabel = preparation ? {
    probe: "Lecture des pistes…", queued: "Préparation en attente…",
    video: "Conversion vidéo H.264", audio: "Préparation du son AAC",
    subtitles: "Chargement des sous-titres…",
    finalizing: "Finalisation du fichier…", scan: "Analyse Microsoft Defender…", ready: "Ouverture du lecteur…",
  }[preparation.stage] : "Ouverture du média…";

  return <dialog ref={dialogRef} className="sly-media-dialog" aria-labelledby="sly-media-player-title" onCancel={(event) => { event.preventDefault(); if (fallbackFullscreen) setFallbackFullscreen(false); else close(); }}>
    <div ref={frameRef} className={`sly-media-player ${fallbackFullscreen ? "is-fallback-fullscreen" : ""}`}>
      <header><div><span className="sly-media-clean"><i /><ShieldCheck size={12} /> FICHIER VALIDÉ</span><h2 id="sly-media-player-title">{episode.episodeTitle}</h2><p>{episode.seriesTitle}{episode.seasonNumber !== null && ` · Saison ${episode.seasonNumber}`}{episode.episodeNumber !== null && ` · Épisode ${episode.episodeNumber}`}</p></div>
        <div className="sly-media-window-actions"><button type="button" onClick={() => void toggleFullscreen()} aria-label={expanded ? "Quitter le plein écran" : "Activer le plein écran"}>{expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button><button type="button" onClick={close} aria-label="Fermer le lecteur" data-player-close><X size={19} /></button></div>
      </header>
      <div className={`sly-media-stage ${episode.kind}`}>
        {source && (episode.kind === "video" ?
          // Une piste n'est ajoutée que si des sous-titres sont présents et sélectionnés.
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video key={source.url} ref={attachMedia} src={source.url} controls playsInline preload="auto" controlsList="nodownload nofullscreen" aria-label={`Lecture vidéo de ${episode.episodeTitle}`} {...events}>
            {subtitle && subtitle.index === subtitleIndex && <track ref={attachTrack} key={subtitle.url} kind="subtitles" src={subtitle.url} srcLang={subtitle.language} label={subtitle.label} default />}
          </video> :
          <div className="sly-media-audio-stage"><Music2 size={50} /><h3>{episode.episodeTitle}</h3>
            {/* Les pistes locales n'ont pas nécessairement de transcription. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio key={source.url} ref={attachMedia} src={source.url} controls preload="auto" controlsList="nodownload" aria-label={`Lecture audio de ${episode.episodeTitle}`} {...events} />
          </div>)}
        {episode.kind === "video" && subtitle?.index === subtitleIndex && !subtitleError && captionLines.length > 0 && <div className="sly-media-captions" aria-live="off">{captionLines.map((line, index) => <span className="sly-media-caption-line" key={`${index}:${line}`}>{line}</span>)}</div>}
        {resumePrompt && !error && <div className="sly-media-player-overlay sly-media-resume-prompt"><Clock3 size={30} /><h3>Reprendre la lecture ?</h3><p>Arrêt à {formatMediaTime(initialRecord?.position || 0)} sur {formatMediaTime(initialRecord?.duration || 0)}</p><div><button type="button" className="sly-media-primary" onClick={() => chooseStart(initialRecord?.position || 0)}><CirclePlay size={17} /> Reprendre à {formatMediaTime(initialRecord?.position || 0)}</button><button type="button" onClick={() => chooseStart(0)}><RotateCcw size={15} /> Depuis le début</button></div></div>}
        {!resumePrompt && (loading || buffering) && !error && <div className="sly-media-player-overlay sly-media-loading" role="status"><LoaderCircle size={28} className="sly-media-spin" /><span>{source && !preparation ? "Chargement de la lecture…" : preparationLabel}</span>{preparation?.percent !== null && preparation?.percent !== undefined && <div className="sly-media-conversion-progress"><progress max={100} value={preparation.percent} aria-label="Préparation du média" /><b>{preparation.percent} %</b></div>}{!source && preparation?.stage === "video" && <small>{preparation.hardware ? "Accélération NVIDIA" : "Conversion sur le processeur"} · Original conservé</small>}{!source && <small>La copie compatible sera réutilisée aux prochaines lectures.</small>}</div>}
        {error && <div className="sly-media-player-overlay" role="alert"><p>{error}</p><button type="button" className="sly-media-primary" onClick={() => void recover(false)}><RotateCcw size={16} /> Réessayer</button></div>}
      </div>
      <div className="sly-media-native-meta"><span className={playing ? "is-playing" : ""}>{error ? "Indisponible" : playing ? "Lecture" : loading ? "Préparation" : "Pause"}</span><span><Clock3 size={14} /> {formatMediaTime(position)} / {formatMediaTime(duration)}</span>{source && <span>{source.videoAdapted ? "Vidéo H.264 · " : ""}{source.audioAdapted ? `Audio ${source.audioCodec || "AAC"}${["fr", "fra", "fre", "french"].includes(source.audioLanguage || "") ? " · FR" : ""}` : "Audio du fichier"}</span>}</div>
      <footer><div className="sly-media-episode-nav"><button type="button" disabled={!previous} onClick={() => previous && select(previous)} aria-label="Épisode précédent"><SkipBack size={17} /> Précédent</button><button type="button" disabled={!next} onClick={() => next && select(next)} aria-label="Épisode suivant">Suivant <SkipForward size={17} />{nextReady && <span className="sly-media-next-ready">prêt</span>}</button></div>
      {source && <div className="sly-media-track-controls">
        {!!source.audioTracks?.length && <label><Music2 size={15} /><span>Audio</span><select aria-label="Piste audio" value={audioIndex ?? ""} disabled={loading} onChange={(event) => void recover(false, Number(event.target.value))}>{source.audioTracks.map((track) => <option key={track.index} value={track.index}>{trackLabel(track)} · {track.codec.toUpperCase()}</option>)}</select></label>}
        {episode.kind === "video" && <label><Captions size={16} /><span>Sous-titres</span><select aria-label="Sous-titres" value={subtitleIndex ?? ""} disabled={!source.subtitleTracks?.some((track) => track.supported !== false)} onChange={(event) => chooseSubtitle(event.target.value)}><option value="">{source.subtitleTracks?.length ? "Désactivés" : "Aucun sous-titre intégré"}</option>{source.subtitleTracks?.map((track) => <option key={track.index} value={track.index} disabled={track.supported === false}>{trackLabel(track)}</option>)}</select></label>}
        {subtitleIndex !== null && (!subtitle || subtitle.index !== subtitleIndex) && !subtitleError && <span className="sly-media-subtitle-loading" role="status"><LoaderCircle size={14} className="sly-media-spin" /> Chargement…</span>}
      </div>}
      {onCast && episode.kind === "video" && <button type="button" data-player-cast disabled={!source} onClick={() => { save(); mediaRef.current?.pause(); wantsPlayback.current = false; setPlaying(false); onCast({ position: checkpoint.current.position, audioTrack: audioIndex ?? undefined, subtitleTrack: subtitleIndex }); }}><Cast size={16} /> Caster</button>}
      <span className="sly-media-source-meta"><LockKeyhole size={14} /> Lecture et suivi locaux</span></footer>
      {subtitleError && <div className="sly-media-player-error sly-media-subtitle-error" role="alert"><span>{subtitleError}</span><button type="button" onClick={() => { setSubtitle(null); setSubtitleError(""); setSubtitleAttempt((value) => value + 1); }}>Réessayer</button></div>}
      {saveError && <div className="sly-media-player-error" role="alert">{saveError}</div>}
    </div>
  </dialog>;
}
