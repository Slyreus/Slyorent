"use client";
import { Cast, Check, ChevronDown, ListVideo, LoaderCircle, Pause, Play, RefreshCw, SkipBack, SkipForward, Square, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CastControl, CastDiscovery, CastRequest, CastStart, CastStatus } from "../../lib/media-cast";
import { formatMediaTime, trackLabel, type WatchRecord } from "../../lib/media-playback";
import type { MediaBridge } from "./MediaLibrary";

type Props = { getBridge: () => MediaBridge; request: CastRequest | null; onDismiss: () => void; onStarted: () => void; onProgress: (key: string, record: WatchRecord) => void };
const message = (error: unknown) => error instanceof Error ? error.message : "Cast indisponible.";
const rangeKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"];
function castLabel(state: CastStatus) {
  if (!state.active) return "Cast interrompu";
  if (state.pairingCode) return "En attente de l’écran";
  if (state.loading) return state.phase === "connecting" ? "Connexion à l’appareil…" : state.phase === "loading" ? "Ouverture sur l’appareil…" : "Préparation de la vidéo…";
  if (state.buffering) return "Chargement sur l’appareil…";
  if (state.duration && (state.position || 0) >= state.duration && !state.playing) return "Lecture terminée";
  return state.playing ? "Lecture sur l’appareil" : "En pause";
}
export function CastPanel({ getBridge, request, onDismiss, onStarted, onProgress }: Props) {
  const [state, setState] = useState<CastStatus>({ active: false });
  const [discovery, setDiscovery] = useState<CastDiscovery | null>(null);
  const [selected, setSelected] = useState("");
  const [autoNext, setAutoNext] = useState(true);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const [queueOpen, setQueueOpen] = useState(true);
  const [lastStart, setLastStart] = useState<CastStart | null>(null);
  const [finding, setFinding] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLElement>(null);
  const queueList = useRef<HTMLOListElement>(null);
  const mutating = useRef(false), revision = useRef(0), focusWorkflow = useRef(false);
  const dismissedError = useRef("");
  const scan = useCallback(async () => {
    setFinding(true); setError("");
    try { const result = await getBridge().castDiscover?.(); if (!result) throw new Error("Installez la dernière version de Slyorrent."); setDiscovery(result); setSelected(result.devices[0]?.id || (result.networks[0] ? `browser:${result.networks[0].id}` : "")); }
    catch (caught) { setError(message(caught)); } finally { setFinding(false); }
  }, [getBridge]);
  useEffect(() => {
    if (!request) return;
    const current = dialog.current;
    if (current && !current.open) current.showModal(); void Promise.resolve().then(scan);
    return () => { current?.close(); };
  }, [request, scan]);
  useEffect(() => {
    let cancelled = false, polling = false, lastHistory = 0;
    const poll = async () => {
      if (polling || mutating.current) return; polling = true;
      const snapshot = revision.current;
      try {
        const next = await getBridge().castStatus?.(); if (!next || cancelled || mutating.current || snapshot !== revision.current) return;
        if (next.active) dismissedError.current = "";
        const visible = !next.active && next.error === dismissedError.current ? { ...next, error: undefined } : next;
        setState((previous) => !visible.active && visible.error && previous.item ? { ...previous, ...visible } : visible);
        if (next.watchRecord) onProgress(next.watchRecord.key, next.watchRecord);
        if (next.active && Date.now() - lastHistory > 6000) { lastHistory = Date.now(); const history = await getBridge().watchHistory(); if (!cancelled) for (const [key, record] of Object.entries(history)) onProgress(key, record); }
      } catch { if (!cancelled && snapshot === revision.current && !mutating.current) setError("Connexion au cast interrompue."); }
      finally { polling = false; }
    };
    void poll(); const timer = setInterval(() => { void poll(); }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [getBridge, onProgress]);
  useEffect(() => {
    if (!state.active || !focusWorkflow.current) return;
    focusWorkflow.current = false;
    const frame = window.requestAnimationFrame(() => { panel.current?.focus({ preventScroll: true }); panel.current?.scrollIntoView({ block: "start", behavior: "instant" }); });
    return () => window.cancelAnimationFrame(frame);
  }, [state.active, request]);
  useEffect(() => {
    const list = queueList.current, current = list?.querySelector<HTMLElement>("[aria-current='true']");
    if (list && current) list.scrollTop = Math.max(0, current.offsetTop - list.offsetTop - 8);
  }, [state.index, queueOpen]);
  async function start(retry?: CastStart) {
    if (mutating.current || !retry && (!request || !selected)) return;
    const options = selected.startsWith("browser:") ? { kind: "browser" as const, networkId: selected.slice(8) } : { deviceId: selected };
    const params = retry || { ...request!, ...options, autoNext };
    mutating.current = true; revision.current++; setBusy(true); setError(""); dismissedError.current = "";
    try {
      if (retry) await getBridge().castDiscover?.();
      const next = await getBridge().castStart?.(params); if (!next?.active) throw new Error(next?.error || "Cast indisponible.");
      setLastStart(params); focusWorkflow.current = true; setQueueOpen(true);
      setState(next); onStarted(); onDismiss();
    } catch (caught) { setError(message(caught)); } finally { mutating.current = false; setBusy(false); }
  }
  async function control(options: CastControl) {
    if (mutating.current) return;
    mutating.current = true; revision.current++; setBusy(true); setError("");
    try { const next = await getBridge().castControl?.(options); if (next) setState(next); }
    catch (caught) { setError(message(caught)); } finally { setBusy(false); }
    mutating.current = false;
  }
  function dismissFailure() { dismissedError.current = state.error || ""; revision.current++; setState({ active: false }); setError(""); }
  const progress = state.duration ? Math.round((state.position || 0) / state.duration * 1000) : 0;
  const queue = state.queue || lastStart?.queue || [];
  const index = state.index || 0;
  const enabled = state.active && !state.loading && !state.pairingCode;
  const step = state.phase === "connecting" && state.loading || state.pairingCode ? 0 : state.loading ? 1 : 2;
  const errorText = error || state.error;
  const preparation = state.preparation;
  return <>
    {(state.active || state.error && state.item) && <section ref={panel} tabIndex={-1} className={`sly-cast-panel ${!state.active ? "is-interrupted" : ""}`} aria-label="Suivi du cast">
      <div className="sly-cast-title"><span className="sly-cast-icon"><Cast size={23} /></span><div><span className="sly-cast-eyebrow">{state.active ? "CAST EN COURS" : "CAST INTERROMPU"} · {state.deviceName}</span><h2>{state.item?.title}</h2><small role="status">{(state.loading || state.buffering) && <LoaderCircle size={13} className="sly-media-spin" />}{castLabel(state)} · Épisode {index + 1}/{state.total || queue.length}</small></div><button type="button" disabled={busy} onClick={() => state.active ? void control({ action: "stop" }) : dismissFailure()}>{state.active ? <Square size={15} /> : <X size={15} />}{state.active ? "Arrêter le cast" : "Fermer"}</button></div>
      <ol className="sly-cast-steps" aria-label="Étapes du cast">{["Appareil", "Préparation", "Lecture"].map((label, current) => <li key={label} aria-current={current === step ? "step" : undefined} className={current < step ? "is-done" : ""}><span>{current < step ? <Check size={12} /> : current + 1}</span>{label}</li>)}</ol>
      {state.active && state.pairingCode && <div className="sly-cast-pair"><p>Ouvrir sur l’autre écran <strong>{state.receiverUrl}</strong></p><p>Code <b>{state.pairingCode}</b> · valable 2 min</p></div>}
      {state.loading && <div className="sly-cast-preparation"><progress max={100} value={preparation?.percent ?? undefined} aria-label="Préparation du cast" /><small>{preparation?.stage === "video" ? "Conversion H.264" : preparation?.stage === "scan" ? "Analyse Defender" : castLabel(state)}{preparation?.percent !== null && preparation?.percent !== undefined && ` · ${preparation.percent} %`}</small></div>}
      <div className="sly-cast-controls">
        <button type="button" aria-label="Épisode précédent sur l’appareil" disabled={busy || !enabled || !index} onClick={() => void control({ action: "previous" })}><SkipBack size={17} /></button>
        <button type="button" className="sly-cast-play" aria-label={state.playing ? "Mettre le cast en pause" : "Reprendre le cast"} disabled={busy || !enabled} onClick={() => void control({ action: state.playing ? "pause" : "play" })}>{state.playing ? <Pause size={17} /> : <Play size={17} />}{state.playing ? "Pause" : "Lire"}</button>
        <button type="button" aria-label="Épisode suivant sur l’appareil" disabled={busy || !enabled || index + 1 >= (state.total || 0)} onClick={() => void control({ action: "next" })}><SkipForward size={17} /></button>
        <div className="sly-cast-timeline"><input type="range" min={0} max={1000} value={seekDraft ?? progress} aria-label="Position sur l’appareil" disabled={busy || !enabled || !state.duration} onChange={(event) => setSeekDraft(Number(event.target.value))} onPointerCancel={() => setSeekDraft(null)} onPointerUp={(event) => { const value = Number(event.currentTarget.value); setSeekDraft(null); void control({ action: "seek", value: value / 1000 * (state.duration || 0) }); }} onKeyUp={(event) => { if (rangeKeys.includes(event.key)) { setSeekDraft(null); void control({ action: "seek", value: Number(event.currentTarget.value) / 1000 * (state.duration || 0) }); } }} /><small>{formatMediaTime(state.position || 0)} / {state.duration ? formatMediaTime(state.duration) : "—"}</small></div>
        {state.volumeSupported && <label className="sly-cast-volume"><Volume2 size={16} /><input type="range" min={0} max={100} value={volumeDraft ?? Math.round((state.volume ?? 1) * 100)} aria-label="Volume sur l’appareil" disabled={busy || !enabled} onChange={(event) => setVolumeDraft(Number(event.target.value))} onPointerCancel={() => setVolumeDraft(null)} onPointerUp={(event) => { setVolumeDraft(null); void control({ action: "volume", value: Number(event.currentTarget.value) / 100 }); }} onKeyUp={(event) => { if (rangeKeys.includes(event.key)) { setVolumeDraft(null); void control({ action: "volume", value: Number(event.currentTarget.value) / 100 }); } }} /><small>{state.volume === undefined ? "Volume" : `${Math.round(state.volume * 100)} %`}</small></label>}
      </div>
      <div className="sly-cast-options"><label><input type="checkbox" checked={Boolean(state.autoNext)} disabled={busy || !state.active} onChange={(event) => void control({ action: "autoNext", value: event.target.checked })} /> Épisode suivant automatique</label>
        {(state.audioTracks?.length || 0) > 1 && <label>Audio <select aria-label="Piste audio du cast" value={state.selectedAudioTrack ?? ""} disabled={busy || !enabled} onChange={(event) => void control({ action: "tracks", audioTrack: Number(event.target.value) })}>{state.audioTracks?.map((track) => <option key={track.index} value={track.index}>{trackLabel(track)}</option>)}</select></label>}
        {Boolean(state.subtitleTracks?.length) && <label>Sous-titres <select aria-label="Sous-titres du cast" value={state.selectedSubtitleTrack ?? "off"} disabled={busy || !enabled} onChange={(event) => void control({ action: "tracks", subtitleTrack: event.target.value === "off" ? null : Number(event.target.value) })}><option value="off">Désactivés</option>{state.subtitleTracks?.map((track) => <option key={track.index} value={track.index} disabled={!track.supported}>{trackLabel(track)}</option>)}</select></label>}
      </div>
      {queue.length > 0 && <details className="sly-cast-queue" open={queueOpen} onToggle={(event) => setQueueOpen(event.currentTarget.open)}><summary><ListVideo size={16} /> File de lecture <span>{queue.length}</span><ChevronDown size={15} /></summary><ol ref={queueList}>{queue.map((item, current) => <li key={`${item.id}:${item.fileIndex}`} aria-current={current === index ? "true" : undefined}><button type="button" disabled={busy || !enabled || current === index} onClick={() => void control({ action: "episode", value: current })} aria-label={`Lire sur l’appareil : ${item.title}`}><span>{current === index ? state.playing ? <Play size={13} /> : <Pause size={13} /> : current + 1}</span><strong>{item.title}</strong><small>{current === index ? "En cours" : current === index + 1 ? state.autoNext ? state.nextPrepared ? "Suivant · prêt" : "Suivant" : "À suivre" : current < index ? "Précédent" : "À suivre"}</small></button></li>)}</ol></details>}
      {errorText && <div className="sly-cast-error" role="alert"><span>{errorText}</span>{!state.active && lastStart && <button type="button" disabled={busy} onClick={() => void start({ ...lastStart, queue, index, position: state.position || 0, autoNext: Boolean(state.autoNext), audioTrack: state.selectedAudioTrack ?? undefined, subtitleTrack: state.selectedSubtitleTrack })}><RefreshCw size={15} /> Réessayer</button>}</div>}
      <small className="sly-cast-hint">{state.kind === "dlna" ? "Fonctions selon la TV · " : ""}Slyorrent doit rester ouvert.</small>
    </section>}
    {errorText && !state.item && !request && <p className="sly-cast-error" role="alert">{errorText}</p>}
    {request && <dialog ref={dialog} className="sly-cast-dialog" aria-labelledby="sly-cast-heading" onCancel={(event) => { event.preventDefault(); if (!busy) onDismiss(); }}>
      <header><h2 id="sly-cast-heading"><Cast size={22} /> Caster</h2><button type="button" aria-label="Fermer la sélection d’appareil" disabled={busy} onClick={onDismiss}><X size={19} /></button></header>
      <p>Chromecast, Google TV, DLNA ou navigateur sur le même réseau privé.</p>
      <div className="sly-cast-selection"><strong>{request.queue[request.index]?.title}</strong><small>Reprise à {formatMediaTime(request.position)} · {request.queue.length - request.index} épisode(s) dans la suite</small></div>
      <label htmlFor="sly-cast-device">Appareil</label><select id="sly-cast-device" value={selected} disabled={finding || busy} onChange={(event) => setSelected(event.target.value)}><option value="">Choisir un appareil</option>{discovery?.devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.kind === "dlna" ? "DLNA" : "Google Cast"}</option>)}{discovery?.networks.map((network) => <option key={network.id} value={`browser:${network.id}`}>Autre écran · navigateur · {network.name}</option>)}</select>
      {finding && <p role="status"><LoaderCircle size={16} className="sly-media-spin" /> Recherche…</p>}
      {!finding && discovery && !discovery.devices.length && <p>Aucun appareil détecté. Le mode navigateur reste disponible sur un réseau privé.</p>}
      <label className="sly-cast-check"><input type="checkbox" checked={autoNext} onChange={(event) => setAutoNext(event.target.checked)} /> Épisode suivant automatique</label>
      <small>Seuls les médias validés sont accessibles à l’appareil choisi. L’accès réseau se ferme à l’arrêt du cast. Pas d’AirPlay ni de Miracast.</small>
      {error && <p role="alert" className="sly-cast-error">{error}</p>}
      {busy && <p className="sly-cast-launching" role="status"><LoaderCircle size={16} className="sly-media-spin" /> Connexion à l’appareil…</p>}
      <footer><button type="button" disabled={finding || busy} onClick={() => void scan()}><RefreshCw size={16} /> Actualiser</button><button type="button" className="sly-media-primary" disabled={finding || busy || !selected} onClick={() => void start()}>{busy ? <LoaderCircle size={16} className="sly-media-spin" /> : <Cast size={16} />}{busy ? "Connexion…" : "Caster"}</button></footer>
    </dialog>}
  </>;
}
