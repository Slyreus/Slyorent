"use client";
import { Cast, LoaderCircle, Pause, Play, RefreshCw, SkipBack, SkipForward, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CastControl, CastDiscovery, CastRequest, CastStatus } from "../../lib/media-cast";
import { formatMediaTime, trackLabel, type WatchRecord } from "../../lib/media-playback";
import type { MediaBridge } from "./MediaLibrary";

type Props = { getBridge: () => MediaBridge; request: CastRequest | null; onDismiss: () => void; onStarted: () => void; onProgress: (key: string, record: WatchRecord) => void };
const message = (error: unknown) => error instanceof Error ? error.message : "Cast indisponible.";
export function CastPanel({ getBridge, request, onDismiss, onStarted, onProgress }: Props) {
  const [state, setState] = useState<CastStatus>({ active: false });
  const [discovery, setDiscovery] = useState<CastDiscovery | null>(null);
  const [selected, setSelected] = useState("");
  const [autoNext, setAutoNext] = useState(true);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [finding, setFinding] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const scan = useCallback(async () => {
    setFinding(true); setError("");
    try { const result = await getBridge().castDiscover?.(); if (!result) throw new Error("Installez la dernière version de Slyorrent."); setDiscovery(result); setSelected(result.devices[0]?.id || (result.networks[0] ? `browser:${result.networks[0].id}` : "")); }
    catch (caught) { setError(message(caught)); } finally { setFinding(false); }
  }, [getBridge]);
  useEffect(() => {
    if (!request) return;
    const current = dialog.current;
    current?.showModal(); void Promise.resolve().then(scan);
    return () => { current?.close(); };
  }, [request, scan]);
  useEffect(() => {
    let cancelled = false, polling = false, lastHistory = 0;
    const poll = async () => {
      if (polling) return; polling = true;
      try {
        const next = await getBridge().castStatus?.(); if (!next || cancelled) return;
        setState(next);
        if (next.watchRecord) onProgress(next.watchRecord.key, next.watchRecord);
        if (next.active && Date.now() - lastHistory > 6000) { lastHistory = Date.now(); const history = await getBridge().watchHistory(); if (!cancelled) for (const [key, record] of Object.entries(history)) onProgress(key, record); }
      } catch { if (!cancelled) setError("Connexion au cast interrompue."); }
      finally { polling = false; }
    };
    void poll(); const timer = setInterval(() => { void poll(); }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [getBridge, onProgress]);
  async function start() {
    if (!request || !selected) return; setBusy(true); setError("");
    try {
      const options = selected.startsWith("browser:") ? { kind: "browser" as const, networkId: selected.slice(8) } : { deviceId: selected };
      const next = await getBridge().castStart?.({ ...request, ...options, autoNext }); if (!next) throw new Error("Cast indisponible.");
      setState(next); onStarted(); onDismiss();
    } catch (caught) { setError(message(caught)); } finally { setBusy(false); }
  }
  async function control(options: CastControl) {
    setBusy(true); setError("");
    try { const next = await getBridge().castControl?.(options); if (next) setState(next); }
    catch (caught) { setError(message(caught)); } finally { setBusy(false); }
  }
  const progress = state.duration ? Math.round((state.position || 0) / state.duration * 1000) : 0;
  return <>
    {state.active && <section className="sly-cast-panel" aria-label="Lecture sur un appareil">
      <div className="sly-cast-title"><Cast size={20} /><div><strong>{state.item?.title}</strong><small>{state.deviceName} · {(state.index || 0) + 1}/{state.total}{state.loading ? " · Préparation…" : state.buffering ? " · Chargement…" : state.playing ? " · Lecture" : " · Pause"}</small></div><button type="button" disabled={busy} onClick={() => void control({ action: "stop" })}><Square size={15} /> Arrêter le cast</button></div>
      {state.pairingCode && <div className="sly-cast-pair"><p>Ouvrir sur l’autre écran <strong>{state.receiverUrl}</strong></p><p>Code <b>{state.pairingCode}</b> · valable 2 min</p></div>}
      {state.loading && state.preparation && <p className="sly-cast-hint">{state.preparation.stage === "video" ? "Conversion H.264" : state.preparation.stage === "scan" ? "Analyse Defender" : "Préparation du fichier"}{state.preparation.percent !== null && ` · ${state.preparation.percent} %`}</p>}
      {!state.pairingCode && <div className="sly-cast-controls">
        <button type="button" aria-label="Épisode précédent sur l’appareil" disabled={busy || state.loading || !state.index} onClick={() => void control({ action: "previous" })}><SkipBack size={16} /></button>
        <button type="button" aria-label={state.playing ? "Mettre le cast en pause" : "Reprendre le cast"} disabled={busy || state.loading} onClick={() => void control({ action: state.playing ? "pause" : "play" })}>{state.playing ? <Pause size={16} /> : <Play size={16} />}</button>
        <button type="button" aria-label="Épisode suivant sur l’appareil" disabled={busy || state.loading || (state.index || 0) + 1 >= (state.total || 0)} onClick={() => void control({ action: "next" })}><SkipForward size={16} /></button>
        <input type="range" min={0} max={1000} value={seekDraft ?? progress} aria-label="Position sur l’appareil" disabled={busy || state.loading || !state.duration} onChange={(event) => setSeekDraft(Number(event.target.value))} onPointerUp={(event) => { const value = Number(event.currentTarget.value); setSeekDraft(null); void control({ action: "seek", value: value / 1000 * (state.duration || 0) }); }} onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) { setSeekDraft(null); void control({ action: "seek", value: Number(event.currentTarget.value) / 1000 * (state.duration || 0) }); } }} />
        <small>{formatMediaTime(state.position || 0)} / {formatMediaTime(state.duration || 0)}</small>
      </div>}
      <div className="sly-cast-options"><label><input type="checkbox" checked={Boolean(state.autoNext)} disabled={busy} onChange={(event) => void control({ action: "autoNext", value: event.target.checked })} /> Épisode suivant automatique</label>
        {(state.audioTracks?.length || 0) > 1 && <label>Audio <select aria-label="Piste audio du cast" value={state.selectedAudioTrack ?? ""} disabled={busy || state.loading} onChange={(event) => void control({ action: "tracks", audioTrack: Number(event.target.value) })}>{state.audioTracks?.map((track) => <option key={track.index} value={track.index}>{trackLabel(track)}</option>)}</select></label>}
        {Boolean(state.subtitleTracks?.length) && <label>Sous-titres <select aria-label="Sous-titres du cast" value={state.selectedSubtitleTrack ?? "off"} disabled={busy || state.loading} onChange={(event) => void control({ action: "tracks", subtitleTrack: event.target.value === "off" ? null : Number(event.target.value) })}><option value="off">Désactivés</option>{state.subtitleTracks?.map((track) => <option key={track.index} value={track.index} disabled={!track.supported}>{trackLabel(track)}</option>)}</select></label>}
      </div>
      {state.kind === "dlna" && <small className="sly-cast-hint">Sous-titres et reprise : selon le téléviseur.</small>}
      <small className="sly-cast-hint">Garder Slyorrent ouvert et les appareils sur le même réseau privé.</small>
    </section>}
    {(error || state.error) && <p className="sly-cast-error" role="alert">{error || state.error}</p>}
    {request && <dialog ref={dialog} className="sly-cast-dialog" aria-labelledby="sly-cast-heading" onCancel={(event) => { event.preventDefault(); if (!busy) onDismiss(); }}>
      <header><h2 id="sly-cast-heading"><Cast size={22} /> Caster</h2><button type="button" aria-label="Fermer la sélection d’appareil" disabled={busy} onClick={onDismiss}><X size={19} /></button></header>
      <p>Chromecast, Google TV, DLNA ou navigateur sur le même réseau privé.</p>
      <label htmlFor="sly-cast-device">Appareil</label><select id="sly-cast-device" value={selected} disabled={finding || busy} onChange={(event) => setSelected(event.target.value)}><option value="">Choisir un appareil</option>{discovery?.devices.map((device) => <option key={device.id} value={device.id}>{device.name} · {device.kind === "dlna" ? "DLNA" : "Google Cast"}</option>)}{discovery?.networks.map((network) => <option key={network.id} value={`browser:${network.id}`}>Autre écran · navigateur · {network.name}</option>)}</select>
      {finding && <p role="status"><LoaderCircle size={16} className="sly-media-spin" /> Recherche…</p>}
      {!finding && discovery && !discovery.devices.length && <p>Aucun appareil détecté. Le mode navigateur reste disponible sur un réseau privé.</p>}
      <label className="sly-cast-check"><input type="checkbox" checked={autoNext} onChange={(event) => setAutoNext(event.target.checked)} /> Épisode suivant automatique</label>
      <small>Seuls les médias validés sont accessibles à l’appareil choisi. L’accès réseau se ferme à l’arrêt du cast. Pas d’AirPlay ni de Miracast.</small>
      {error && <p role="alert" className="sly-cast-error">{error}</p>}
      <footer><button type="button" disabled={finding || busy} onClick={() => void scan()}><RefreshCw size={16} /> Actualiser</button><button type="button" className="sly-media-primary" disabled={finding || busy || !selected} onClick={() => void start()}>{busy ? <LoaderCircle size={16} className="sly-media-spin" /> : <Cast size={16} />} Caster</button></footer>
    </dialog>}
  </>;
}
