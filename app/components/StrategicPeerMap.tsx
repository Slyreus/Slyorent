"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDownLeft, ArrowUpRight, Crosshair, Globe2, Maximize2, Minimize2, Minus, Pause, Play, Plus, X } from "lucide-react";
import { MAP_HEIGHT, MAP_WIDTH, clampViewport, centerViewport, formatRate, normalizeLocalNode, normalizePeers, zoomViewport, type MapPoint, type MapViewport } from "./strategic-peer-map-model.mjs";
import { buildMapRoutes, cityLabelKeys, clientToMap, fitMap, groupPeerCities, isSnapshotFresh } from "./strategic-map-scene.mjs";
import { StrategicMapEffects } from "./StrategicMapEffects";
import { WORLD_LAND_PATH } from "./world-land-110m";
import "./StrategicPeerMap.css";

export type StrategicPeer = {
  id: string; label?: string; torrentId?: number; torrentName?: string;
  countryCode?: string | null; country?: string | null; city?: string | null;
  latitude: number | null; longitude: number | null;
  locationStatus: "resolved" | "unavailable";
  rateDownload: number; rateUpload: number; active?: boolean; progress?: number; encrypted?: boolean;
  connection?: "incoming" | "outgoing";
  direction?: "download" | "upload" | "bidirectional" | "inactive";
};
export type StrategicLocalNode = {
  latitude: number; longitude: number; source: "windows-location-service" | "manual";
  accuracyKm?: number | null; accuracyMeters?: number | null; approximate?: boolean;
};
export type StrategicSnapshotLocation = {
  latitude: number | null; longitude: number | null; source: string;
  accuracyKm?: number | null; accuracyMeters?: number | null; approximate?: boolean;
  status?: "available" | "unavailable";
} | null;
export type StrategicPeerSnapshot = {
  capturedAt?: string; localLocation?: StrategicSnapshotLocation;
  geoProvider?: { offline?: boolean; available?: boolean; name?: string };
  peers?: readonly StrategicPeer[] | null;
  counts?: { observed?: number; active?: number; returned?: number; filtered?: number };
  truncated?: boolean;
};
export type StrategicPeerMapProps = {
  snapshot?: StrategicPeerSnapshot | null;
  /** `undefined` consulte le snapshot; `null` désactive explicitement toute position. */
  localNode?: StrategicLocalNode | null;
  onRequestLocation?: () => void;
  className?: string;
};

type DragState = { pointerId: number; lastX: number; lastY: number };
const INITIAL_VIEWPORT: MapViewport = Object.freeze({ x: 0, y: 0, k: 1 });
const LONGITUDES = [-150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150];
const LATITUDES = [-60, -30, 0, 30, 60];
const REGIONS = [
  { x: 208, y: 97, label: "AMÉRIQUE DU NORD" }, { x: 306, y: 335, label: "AMÉRIQUE DU SUD" },
  { x: 538, y: 95, label: "EUROPE" }, { x: 538, y: 255, label: "AFRIQUE" },
  { x: 740, y: 125, label: "ASIE" }, { x: 858, y: 355, label: "OCÉANIE" },
];

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function useSmoothViewport(target: MapViewport, immediate: boolean) {
  const [displayed, setDisplayed] = useState(target);
  const position = useRef(target);
  useEffect(() => {
    let frame = 0, last = 0;
    const step = (time: number) => {
      const current = position.current;
      const factor = immediate ? 1 : 1 - Math.exp(-Math.min(50, last ? time - last : 16) / 55);
      last = time;
      const near = Math.abs(current.x - target.x) + Math.abs(current.y - target.y) + Math.abs(current.k - target.k) * 200 < .3;
      const next = near || immediate ? target : { x: current.x + (target.x - current.x) * factor, y: current.y + (target.y - current.y) * factor, k: current.k + (target.k - current.k) * factor };
      position.current = next; setDisplayed(next);
      if (next !== target) frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [target, immediate]);
  return displayed;
}

export function StrategicPeerMap({ snapshot, localNode, onRequestLocation, className }: StrategicPeerMapProps) {
  const id = useId().replace(/[^A-Za-z0-9_-]/gu, "");
  const rootRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [targetViewport, setViewport] = useState<MapViewport>(INITIAL_VIEWPORT);
  const [dragging, setDragging] = useState(false);
  const [paused, setPaused] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reducedMotion = useReducedMotion();
  const viewport = useSmoothViewport(targetViewport, reducedMotion || dragging);
  const peers = useMemo(() => normalizePeers(snapshot?.peers), [snapshot?.peers]);
  const cities = useMemo(() => groupPeerCities(peers), [peers]);
  const localCandidate = localNode !== undefined ? localNode : snapshot?.localLocation;
  const local = useMemo(() => normalizeLocalNode(localCandidate), [localCandidate]);
  const localX = local?.point.x ?? null, localY = local?.point.y ?? null;
  const fresh = isSnapshotFresh(snapshot?.capturedAt, now);
  const traffic = useMemo(() => buildMapRoutes(cities, local, fresh), [cities, local, fresh]);
  const selectedCity = cities.find((city) => city.key === selectedKey) || null;
  const labels = useMemo(() => cityLabelKeys(cities, viewport, selectedCity?.key || null, local?.point), [cities, viewport, selectedCity?.key, local?.point]);
  const totals = useMemo(() => cities.reduce((sum, city) => ({ upload: sum.upload + city.upload, download: sum.download + city.download, active: sum.active + city.active }), { upload: 0, download: 0, active: 0 }), [cities]);
  const unlocated = Math.max(0, (snapshot?.peers?.length || 0) - peers.length);
  const transform = `translate(${viewport.x} ${viewport.y}) scale(${viewport.k})`;

  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 1_000);
    const wake = () => setNow(Date.now());
    document.addEventListener("visibilitychange", wake);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", wake); };
  }, []);

  const setZoom = useCallback((factor: number, anchor: MapPoint = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 }) => {
    setViewport((current) => zoomViewport(current, current.k * factor, anchor));
  }, []);
  const recenter = useCallback(() => {
    setViewport(localX === null || localY === null ? INITIAL_VIEWPORT : centerViewport({ x: localX, y: localY }, 1.6));
  }, [localX, localY]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(recenter);
    return () => window.cancelAnimationFrame(frame);
  }, [recenter]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 520 : 1);
      setZoom(Math.exp(-Math.max(-350, Math.min(350, delta)) * .0016), clientToMap(surface.getBoundingClientRect(), event.clientX, event.clientY));
    };
    surface.addEventListener("wheel", wheel, { passive: false });
    return () => surface.removeEventListener("wheel", wheel);
  }, [setZoom]);

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  const toggleFullscreen = async () => {
    setFullscreenError("");
    try {
      if (document.fullscreenElement === rootRef.current) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch { setFullscreenError("Plein écran indisponible."); }
  };
  const panBy = useCallback((x: number, y: number) => {
    setViewport((current) => clampViewport({ ...current, x: current.x + x, y: current.y + y }));
  }, []);
  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
    setDragging(true);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const { scale } = fitMap(bounds.width, bounds.height);
    panBy((event.clientX - drag.lastX) / scale, (event.clientY - drag.lastY) / scale);
    dragRef.current = { ...drag, lastX: event.clientX, lastY: event.clientY };
  };
  const pointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null; setDragging(false);
  };
  const keyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft") panBy(42, 0);
    else if (event.key === "ArrowRight") panBy(-42, 0);
    else if (event.key === "ArrowUp") panBy(0, 42);
    else if (event.key === "ArrowDown") panBy(0, -42);
    else if (event.key === "+" || event.key === "=") setZoom(1.25);
    else if (event.key === "-") setZoom(.8);
    else if (event.key === "Home" || event.key === "0") recenter();
    else if (event.key === "Escape") setSelectedKey(null);
    else return;
    event.preventDefault();
  };
  const status = !fresh ? "Signal en attente" : totals.active ? "Échanges en direct" : "Aucun transfert";
  const localSource = local?.source === "manual" ? "Placement manuel" : "Position Windows";

  return (
    <section ref={rootRef} className={["sly-map", className].filter(Boolean).join(" ")} aria-labelledby={`map-title-${id}`} data-testid="strategic-peer-map" data-motion={paused || reducedMotion ? "paused" : "running"} data-fresh={fresh}>
      <header className="sly-map-header">
        <div className="sly-map-brand"><img src="./slyorus.png" alt="" /><div><p className="sly-map-eyebrow">SLYORUS / P2P</p><h2 id={`map-title-${id}`}>Carte stratégique</h2></div></div>
        <div className="sly-map-metrics" aria-label="Débits des pairs cartographiés">
          <div className="sly-map-metric--upload"><ArrowUpRight size={19} /><span><small>ENVOI</small><b>{fresh ? formatRate(totals.upload) : "—"}</b></span></div>
          <div className="sly-map-metric--download"><ArrowDownLeft size={19} /><span><small>RÉCEPTION</small><b>{fresh ? formatRate(totals.download) : "—"}</b></span></div>
          <div><Globe2 size={17} /><span><small>PAIRS PLACÉS</small><b>{peers.length}<em> / {cities.length} zones</em></b></span></div>
        </div>
      </header>

      <div className="sly-map-frame">
        <div className={`sly-map-stage${dragging ? " sly-map-stage--dragging" : ""}`}>
          <button ref={surfaceRef} type="button" className="sly-map-surface" aria-label="Carte interactive : flèches pour déplacer, plus ou moins pour zoomer, zéro pour recentrer." onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd} onKeyDown={keyDown}>
            <svg className="sly-map-canvas" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} aria-hidden="true" preserveAspectRatio="xMidYMid meet">
              <defs>
                <linearGradient id={`land-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#164158" /><stop offset="1" stopColor="#0b2135" /></linearGradient>
                <pattern id={`dots-${id}`} width="4" height="4" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".65" fill="#3982a0" opacity=".42" /></pattern>
                <pattern id={`grid-${id}`} width="25" height="26" patternUnits="userSpaceOnUse"><path d="M 25 0 H 0 V 26" fill="none" stroke="#215069" strokeWidth=".5" opacity=".25" /></pattern>
                <marker id={`arrow-up-${id}`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M 0 0 L 6 3 L 0 6" fill="none" stroke="#25a8ff" /></marker>
                <marker id={`arrow-down-${id}`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M 0 0 L 6 3 L 0 6" fill="none" stroke="#ff4c62" /></marker>
              </defs>
              <g transform={transform} data-testid="map-viewport">
                <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill={`url(#grid-${id})`} />
                <g className="sly-map-grid">
                  {LONGITUDES.map((lon) => <line key={lon} x1={(lon + 180) / 360 * MAP_WIDTH} x2={(lon + 180) / 360 * MAP_WIDTH} y1={0} y2={MAP_HEIGHT} />)}
                  {LATITUDES.map((lat) => <line key={lat} x1={0} x2={MAP_WIDTH} y1={(90 - lat) / 180 * MAP_HEIGHT} y2={(90 - lat) / 180 * MAP_HEIGHT} />)}
                </g>
                <path className="sly-map-coast" d={WORLD_LAND_PATH} vectorEffect="non-scaling-stroke" />
                <path className="sly-map-land" d={WORLD_LAND_PATH} fill={`url(#land-${id})`} vectorEffect="non-scaling-stroke" />
                <path d={WORLD_LAND_PATH} fill={`url(#dots-${id})`} />
                <g className="sly-map-region-labels">{REGIONS.map((region) => <text key={region.label} x={region.x} y={region.y} fontSize={9 / Math.sqrt(viewport.k)}>{region.label}</text>)}</g>
                <g className="sly-map-arcs">{traffic.routes.map((route) => <path key={route.key} className={`sly-map-route sly-map-route--${route.kind}`} data-direction={route.kind} d={route.curve.path} fill="none" strokeWidth={.55 + route.strength * .8} opacity={selectedCity && selectedCity.key !== route.cityKey ? .12 : .35} vectorEffect="non-scaling-stroke" markerEnd={`url(#arrow-${route.kind === "upload" ? "up" : "down"}-${id})`} />)}</g>
              </g>
            </svg>
            <StrategicMapEffects viewport={viewport} local={local?.point || null} routes={traffic.routes} paused={paused} reducedMotion={reducedMotion} selectedCity={selectedCity?.key || null} />
          </button>

          <svg className="sly-map-nodes" viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} role="group" aria-label="Zones des pairs" preserveAspectRatio="xMidYMid meet">
            <g transform={transform}>
              {cities.map((city) => {
                const active = fresh && city.active > 0;
                const x = city.point.x * viewport.k + viewport.x, y = city.point.y * viewport.k + viewport.y;
                const visible = x > 0 && x < MAP_WIDTH && y > 0 && y < MAP_HEIGHT;
                return <g key={city.key} className={`sly-map-city ${active ? "is-active" : "is-idle"} ${selectedCity?.key === city.key ? "is-selected" : ""}`} role="button" tabIndex={visible ? 0 : -1} aria-label={`${city.name}, ${city.peers.length} pair${city.peers.length > 1 ? "s" : ""}, position approximative`} aria-pressed={selectedCity?.key === city.key} onClick={() => setSelectedKey(city.key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedKey(city.key); } }} transform={`translate(${city.point.x} ${city.point.y}) scale(${1 / viewport.k})`}>
                  <circle className="sly-map-city-hit" r={13} />
                  <circle className="sly-map-city-ring" r={active ? 8 : 5} />
                  <path className="sly-map-city-pin" d="M 0 -3.8 L 3.8 0 L 0 3.8 L -3.8 0 Z" />
                  {labels.has(city.key) && <><path className="sly-map-city-leader" d="M 5 -3 L 12 -12 H 20" /><text x={23} y={-9}>{city.name.length > 23 ? `${city.name.slice(0, 22)}…` : city.name}{city.peers.length > 1 ? ` · ${city.peers.length}` : ""}</text></>}
                </g>;
              })}
              {local && <g className="sly-map-local-node" transform={`translate(${local.point.x} ${local.point.y}) scale(${1 / viewport.k})`} aria-hidden="true"><path d="M -11 -5 V -11 H -5 M 5 -11 H 11 V -5 M 11 5 V 11 H 5 M -5 11 H -11 V 5" /><circle r={4.5} /><text x={0} y={35}>MA BASE</text></g>}
            </g>
          </svg>
          <div className="sly-map-scanlines" aria-hidden="true" />
          <div className="sly-map-vignette" aria-hidden="true" />
        </div>

        <div className="sly-map-signal"><span data-live={fresh && totals.active > 0}><i />{status}</span><small>{fresh ? `${totals.active} actif${totals.active > 1 ? "s" : ""}` : "Débits indisponibles"} · CARTE LOCALE</small></div>
        <div className="sly-map-controls" role="group" aria-label="Commandes de la carte">
          <button type="button" onClick={() => setZoom(1.25)} disabled={targetViewport.k >= 6} aria-label="Zoomer sur la carte" title="Zoomer (+)"><Plus size={16} /></button>
          <button type="button" onClick={() => setZoom(.8)} disabled={targetViewport.k <= 1} aria-label="Dézoomer la carte" title="Dézoomer (−)"><Minus size={16} /></button>
          <span />
          <button type="button" onClick={recenter} aria-label="Recentrer la carte" title="Ma base (0)"><Crosshair size={17} /></button>
          <button type="button" onClick={() => setViewport(INITIAL_VIEWPORT)} aria-label="Vue mondiale" title="Vue mondiale"><Globe2 size={16} /></button>
          <span />
          <button type="button" onClick={() => setPaused((value) => !value)} disabled={reducedMotion} aria-pressed={paused || reducedMotion} aria-label={paused ? "Animer la carte" : "Figer les animations"} title={reducedMotion ? "Animations réduites par le système" : paused ? "Animer" : "Figer les animations"}>{paused || reducedMotion ? <Play size={15} /> : <Pause size={15} />}</button>
          <button type="button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Quitter le plein écran" : "Carte en plein écran"} title={fullscreen ? "Quitter le plein écran (Échap)" : "Plein écran"}>{fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
        </div>

        <aside className="sly-map-base-card">
          <span className="sly-map-base-icon"><Crosshair size={21} /></span>
          <div><small>MA BASE</small><strong>{local ? localSource : "Position non définie"}</strong><p>{local ? "Position privée · session locale" : "Placer la base pour tracer les flux."}</p></div>
          {!local && onRequestLocation && <button type="button" onClick={onRequestLocation}>Localiser</button>}
        </aside>

        {cities.length > 0 && <aside className="sly-map-intel" aria-label="Détail des zones">
          <div className="sly-map-intel-heading"><small>{selectedCity ? "ZONE SÉLECTIONNÉE" : "ZONES CONNECTÉES"}</small>{selectedCity ? <button type="button" onClick={() => setSelectedKey(null)} aria-label="Fermer le détail de la zone"><X size={14} /></button> : <span>{cities.length.toString().padStart(2, "0")}</span>}</div>
          {selectedCity ? <div className="sly-map-city-detail"><h3>{selectedCity.name}</h3><p>{selectedCity.country || "Pays inconnu"} · position GeoIP</p><strong>{selectedCity.peers.length} pair{selectedCity.peers.length > 1 ? "s" : ""} <span>· {fresh ? selectedCity.active : "—"} actif{selectedCity.active > 1 ? "s" : ""}</span></strong><div><span className="sly-map-upload">↑ {fresh ? formatRate(selectedCity.upload) : "—"}</span><span className="sly-map-download">↓ {fresh ? formatRate(selectedCity.download) : "—"}</span></div></div> : <div className="sly-map-city-list">{cities.slice(0, 3).map((city) => <button key={city.key} type="button" onClick={() => setSelectedKey(city.key)}><span><i data-active={fresh && city.active > 0} />{city.name}</span><small>{fresh && city.active ? formatRate(city.upload + city.download) : `${city.peers.length} pair${city.peers.length > 1 ? "s" : ""}`}</small></button>)}</div>}
          <select aria-label="Choisir une zone" value={selectedCity?.key || ""} onChange={(event) => { const city = cities.find((item) => item.key === event.target.value); setSelectedKey(city?.key || null); if (city) setViewport(centerViewport(city.point, Math.max(1.6, targetViewport.k))); }}><option value="">Toutes les zones</option>{cities.map((city) => <option key={city.key} value={city.key}>{city.name}{city.country && city.country !== city.name ? ` · ${city.country}` : ""} · {city.peers.length}</option>)}</select>
        </aside>}

        <div className="sly-map-coordinate-bar" aria-hidden="true"><span>SLY / NET</span><span>ZOOM ×{targetViewport.k.toFixed(1)} · {paused ? "ANIMATION FIGÉE" : reducedMotion ? "MOUVEMENTS RÉDUITS" : "TRAJECTOIRES ILLUSTRÉES"}</span><span>GEO / LOCAL</span></div>
      </div>

      <footer className="sly-map-footer">
        <ul className="sly-map-legend" aria-label="Légende des flux"><li><span className="sly-map-legend-line is-upload" />Envoi</li><li><span className="sly-map-legend-line is-download" />Réception</li><li><span className="sly-map-legend-dot" />Pair sans transfert</li><li><span className="sly-map-legend-base" />Ma base</li></ul>
        <p>Débits réels des pairs placés. Trajets illustrés, pas des paquets ni des itinéraires réseau.</p>
        <div className="sly-map-facts"><span>{snapshot?.geoProvider?.offline === true && snapshot.geoProvider.available === true ? "Données GeoLite2 © MaxMind, géolocalisation approximative" : "GeoIP local indisponible"}</span><span>Fond embarqué · IP masquées</span>{unlocated > 0 && <span>{unlocated} pair{unlocated > 1 ? "s" : ""} non placé{unlocated > 1 ? "s" : ""}</span>}{traffic.total > traffic.routes.length && <span>{traffic.routes.length} routes animées sur {traffic.total}</span>}{snapshot?.truncated && <span>Télémétrie partielle</span>}</div>
        {fullscreenError && <p role="alert">{fullscreenError}</p>}
      </footer>
      <ul className="sly-map-sr-only" aria-label="Détails accessibles des pairs cartographiés">{peers.map((peer) => <li key={peer.id}>{peer.label}, {[peer.city, peer.country].filter(Boolean).join(", ") || "Position approximative"}, {fresh ? `envoi ${formatRate(peer.active ? peer.rateUpload : 0)}, réception ${formatRate(peer.active ? peer.rateDownload : 0)}` : "données anciennes"}, torrent {peer.torrentName}.</li>)}</ul>
    </section>
  );
}

export default StrategicPeerMap;
