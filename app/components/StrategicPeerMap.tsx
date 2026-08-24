"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  MAP_HEIGHT,
  MAP_WIDTH,
  clampViewport,
  centerViewport,
  createArcPath,
  formatRate,
  normalizeLocalNode,
  normalizePeers,
  rateVisual,
  zoomViewport,
  type MapPoint,
  type MapViewport,
  type NormalizedStrategicPeer,
} from "./strategic-peer-map-model.mjs";
import { WORLD_LAND_PATH } from "./world-land-110m";
import "./StrategicPeerMap.css";

export type StrategicPeer = {
  id: string;
  label?: string;
  torrentId?: number;
  torrentName?: string;
  countryCode?: string | null;
  country?: string | null;
  city?: string | null;
  latitude: number | null;
  longitude: number | null;
  locationStatus: "resolved" | "unavailable";
  rateDownload: number;
  rateUpload: number;
  active?: boolean;
  progress?: number;
  encrypted?: boolean;
  connection?: "incoming" | "outgoing";
  direction?: "download" | "upload" | "bidirectional" | "inactive";
};

export type StrategicLocalNode = {
  latitude: number;
  longitude: number;
  source: "windows-location-service" | "manual";
  accuracyKm?: number | null;
  accuracyMeters?: number | null;
  approximate?: boolean;
};

export type StrategicSnapshotLocation = {
  latitude: number | null;
  longitude: number | null;
  source: string;
  accuracyKm?: number | null;
  accuracyMeters?: number | null;
  approximate?: boolean;
  status?: "available" | "unavailable";
} | null;

export type StrategicPeerSnapshot = {
  capturedAt?: string;
  localLocation?: StrategicSnapshotLocation;
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
type FlowStyle = CSSProperties & { "--sly-map-flow-duration": string };
type MapArc = {
  key: string;
  kind: "upload" | "download";
  path: string;
  rate: number;
  peer: NormalizedStrategicPeer;
  visual: ReturnType<typeof rateVisual>;
};

const INITIAL_VIEWPORT: MapViewport = Object.freeze({ x: 0, y: 0, k: 1 });
const LONGITUDE_LINES = [-120, -60, 0, 60, 120] as const;
const LATITUDE_LINES = [-60, -30, 0, 30, 60] as const;

function mapPointFromClient(element: HTMLElement, clientX: number, clientY: number): MapPoint {
  const bounds = element.getBoundingClientRect();
  return {
    x: bounds.width > 0 ? ((clientX - bounds.left) / bounds.width) * MAP_WIDTH : MAP_WIDTH / 2,
    y: bounds.height > 0 ? ((clientY - bounds.top) / bounds.height) * MAP_HEIGHT : MAP_HEIGHT / 2,
  };
}

function locationText(peer: NormalizedStrategicPeer) {
  return [peer.city, peer.country].filter(Boolean).join(", ") || "Position approximative";
}

function sourceText(source: "windows-location-service" | "manual") {
  return source === "manual" ? "saisie manuelle" : "localisation Windows";
}

function arcDescription(arc: MapArc) {
  const action = arc.kind === "upload" ? "envoi vers" : "réception depuis";
  return `${action} ${arc.peer.label}, ${locationText(arc.peer)}, ${formatRate(arc.rate)}`;
}

export function StrategicPeerMap({ snapshot, localNode, onRequestLocation, className }: StrategicPeerMapProps) {
  const stableId = useId().replace(/[^A-Za-z0-9_-]/gu, "");
  const titleId = `sly-map-title-${stableId}`;
  const descriptionId = `sly-map-description-${stableId}`;
  const uploadMarkerId = `sly-map-upload-${stableId}`;
  const downloadMarkerId = `sly-map-download-${stableId}`;
  const [viewport, setViewport] = useState<MapViewport>(INITIAL_VIEWPORT);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);

  const peers = useMemo(() => normalizePeers(snapshot?.peers), [snapshot?.peers]);
  const localCandidate = localNode !== undefined ? localNode : snapshot?.localLocation;
  const local = useMemo(() => normalizeLocalNode(localCandidate), [localCandidate]);
  const plottedActive = useMemo(() => peers.filter((peer) => peer.active).length, [peers]);
  const localX = local?.point.x ?? null;
  const localY = local?.point.y ?? null;
  const rejectedOrUnlocated = Math.max(0, (snapshot?.peers?.length || 0) - peers.length);

  const arcs = useMemo(() => {
    if (!local) return [];
    const maximumUpload = Math.max(1, ...peers.map((peer) => peer.active ? peer.rateUpload : 0));
    const maximumDownload = Math.max(1, ...peers.map((peer) => peer.active ? peer.rateDownload : 0));
    const result: MapArc[] = [];
    for (const peer of peers) {
      if (!peer.active) continue;
      if (peer.rateUpload > 0) {
        const path = createArcPath(local.point, peer.point, 1);
        if (path) result.push({ key: `${peer.id}-upload`, kind: "upload", path, rate: peer.rateUpload, peer, visual: rateVisual(peer.rateUpload, maximumUpload) });
      }
      if (peer.rateDownload > 0) {
        const path = createArcPath(peer.point, local.point, -1);
        if (path) result.push({ key: `${peer.id}-download`, kind: "download", path, rate: peer.rateDownload, peer, visual: rateVisual(peer.rateDownload, maximumDownload) });
      }
    }
    return result;
  }, [local, peers]);

  const setZoom = useCallback((factor: number, anchor: MapPoint = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 }) => {
    setViewport((current) => zoomViewport(current, current.k * factor, anchor));
  }, []);

  const recenter = useCallback(() => {
    setViewport(localX === null || localY === null ? INITIAL_VIEWPORT : centerViewport({ x: localX, y: localY }, 1.6));
  }, [localX, localY]);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(recenter);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [recenter]);

  const panBy = useCallback((deltaX: number, deltaY: number) => {
    setViewport((current) => clampViewport({ ...current, x: current.x + deltaX, y: current.y + deltaY }));
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
    setDragging(true);
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const deltaX = bounds.width > 0 ? ((event.clientX - drag.lastX) / bounds.width) * MAP_WIDTH : 0;
    const deltaY = bounds.height > 0 ? ((event.clientY - drag.lastY) / bounds.height) * MAP_HEIGHT : 0;
    dragRef.current = { ...drag, lastX: event.clientX, lastY: event.clientY };
    panBy(deltaX, deltaY);
  }, [panBy]);

  const finishPointerInteraction = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
  }, []);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const anchor = mapPointFromClient(event.currentTarget, event.clientX, event.clientY);
    setZoom(Math.exp(-event.deltaY * 0.0012), anchor);
  }, [setZoom]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = 42;
    if (event.key === "ArrowLeft") panBy(step, 0);
    else if (event.key === "ArrowRight") panBy(-step, 0);
    else if (event.key === "ArrowUp") panBy(0, step);
    else if (event.key === "ArrowDown") panBy(0, -step);
    else if (event.key === "+" || event.key === "=") setZoom(1.25);
    else if (event.key === "-") setZoom(0.8);
    else if (event.key === "0" || event.key === "Home") recenter();
    else return;
    event.preventDefault();
  }, [panBy, recenter, setZoom]);

  const rootClassName = ["sly-map", className].filter(Boolean).join(" ");
  const localSummary = local
    ? `Position approximative : ${sourceText(local.source)}${local.accuracyKm === null ? "" : `, précision ${local.accuracyKm.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km`}.`
    : "Position locale absente. Aucun flux tracé.";

  return (
    <section className={rootClassName} aria-labelledby={titleId} data-testid="strategic-peer-map">
      <header className="sly-map-header">
        <div>
          <p className="sly-map-eyebrow">FLUX P2P</p>
          <h2 id={titleId}>Pairs en temps réel</h2>
          <p className="sly-map-summary" aria-live="polite">
            Pairs : {peers.length} · actifs : {plottedActive}
          </p>
        </div>
        <div className="sly-map-local-badge" data-ready={local ? "true" : "false"}>
          <span aria-hidden="true" />
          {local ? "Position définie" : "Position requise"}
        </div>
      </header>

      <div className="sly-map-frame">
        <button
          type="button"
          className={`sly-map-stage${dragging ? " sly-map-stage--dragging" : ""}`}
          aria-label="Carte interactive : flèches pour déplacer, plus ou moins pour zoomer, zéro pour recentrer."
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerInteraction}
          onPointerCancel={finishPointerInteraction}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
        >
          <svg
            className="sly-map-canvas"
            viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
            role="img"
            aria-labelledby={`${titleId} ${descriptionId}`}
            preserveAspectRatio="xMidYMid meet"
          >
            <title>Flux P2P approximatifs sur une carte locale</title>
            <desc id={descriptionId}>{localSummary} Identifiants éphémères ; adresses IP filtrées.</desc>
            <defs>
              <linearGradient id={`sly-map-ocean-${stableId}`} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#020817" />
                <stop offset="0.52" stopColor="#071a31" />
                <stop offset="1" stopColor="#03101f" />
              </linearGradient>
              <filter id={`sly-map-glow-${stableId}`} x="-100%" y="-100%" width="300%" height="300%">
                <feGaussianBlur stdDeviation="3.2" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <marker id={uploadMarkerId} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto" markerUnits="strokeWidth">
                <path d="M 0 0 L 5 2.5 L 0 5 z" fill="#25a8ff" />
              </marker>
              <marker id={downloadMarkerId} markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto" markerUnits="strokeWidth">
                <path d="M 0 0 L 5 2.5 L 0 5 z" fill="#ff4c62" />
              </marker>
            </defs>
            <rect width={MAP_WIDTH} height={MAP_HEIGHT} fill={`url(#sly-map-ocean-${stableId})`} />
            <g aria-hidden="true" transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.k})`}>
              <g className="sly-map-grid">
                {LONGITUDE_LINES.map((longitude) => {
                  const x = ((longitude + 180) / 360) * MAP_WIDTH;
                  return <line key={`lon-${longitude}`} x1={x} x2={x} y1={0} y2={MAP_HEIGHT} vectorEffect="non-scaling-stroke" />;
                })}
                {LATITUDE_LINES.map((latitude) => {
                  const y = ((90 - latitude) / 180) * MAP_HEIGHT;
                  return <line key={`lat-${latitude}`} x1={0} x2={MAP_WIDTH} y1={y} y2={y} vectorEffect="non-scaling-stroke" />;
                })}
              </g>
              <path className="sly-map-land" d={WORLD_LAND_PATH} vectorEffect="non-scaling-stroke" />
              <g className="sly-map-arcs">
                {arcs.map((arc) => {
                  const style: FlowStyle = { "--sly-map-flow-duration": `${arc.visual.durationSeconds}s` };
                  return (
                    <path
                      key={arc.key}
                      className={`sly-map-arc sly-map-arc--${arc.kind}`}
                      d={arc.path}
                      pathLength={1}
                      fill="none"
                      opacity={arc.visual.opacity}
                      strokeWidth={arc.visual.strokeWidth}
                      markerEnd={`url(#${arc.kind === "upload" ? uploadMarkerId : downloadMarkerId})`}
                      vectorEffect="non-scaling-stroke"
                      style={style}
                    />
                  );
                })}
              </g>
              <g className="sly-map-peers">
                {peers.map((peer) => (
                  <g key={peer.id} className={peer.active ? "sly-map-peer sly-map-peer--active" : "sly-map-peer sly-map-peer--inactive"}>
                    {peer.active && <circle className="sly-map-peer-aura" cx={peer.point.x} cy={peer.point.y} r={8 / viewport.k} />}
                    <circle cx={peer.point.x} cy={peer.point.y} r={(peer.active ? 4.1 : 3.2) / viewport.k} />
                  </g>
                ))}
              </g>
              {local && (
                <g className="sly-map-local-node">
                  <circle className="sly-map-local-pulse" cx={local.point.x} cy={local.point.y} r={13 / viewport.k} />
                  <circle className="sly-map-local-core" cx={local.point.x} cy={local.point.y} r={6 / viewport.k} />
                </g>
              )}
            </g>
          </svg>
        </button>

        <div className="sly-map-controls" role="group" aria-label="Commandes de la carte">
          <button type="button" onClick={() => setZoom(1.25)} disabled={viewport.k >= 6} aria-label="Zoomer sur la carte">+</button>
          <button type="button" onClick={() => setZoom(0.8)} disabled={viewport.k <= 1} aria-label="Dézoomer la carte">−</button>
          <button type="button" onClick={recenter} aria-label={local ? "Recentrer sur la position locale" : "Recentrer la carte mondiale"}>Centrer</button>
        </div>

        {!local && (
          <div className="sly-map-empty" role="status">
            <span className="sly-map-empty-icon" aria-hidden="true">◎</span>
            <strong>Position requise</strong>
            <p>Nécessaire au tracé des flux. Aucun service web utilisé.</p>
            {onRequestLocation && <button type="button" onClick={onRequestLocation}>Localiser</button>}
          </div>
        )}
      </div>

      <footer className="sly-map-footer">
        <ul className="sly-map-legend" aria-label="Légende des flux">
          <li><span className="sly-map-legend-line sly-map-legend-line--upload" aria-hidden="true" />Envoi sortant</li>
          <li><span className="sly-map-legend-line sly-map-legend-line--download" aria-hidden="true" />Réception entrante</li>
          <li><span className="sly-map-legend-dot sly-map-legend-dot--inactive" aria-hidden="true" />Pair inactif</li>
          <li><span className="sly-map-legend-dot sly-map-legend-dot--local" aria-hidden="true" />Position locale</li>
        </ul>
        <div className="sly-map-facts">
          <span>Fond de carte intégré · 0 tuile réseau</span>
          <span>{snapshot?.geoProvider?.offline === true && snapshot.geoProvider.available === true
            ? "Données GeoLite2 © MaxMind, géolocalisation approximative"
            : "GeoIP local indisponible"}</span>
          {rejectedOrUnlocated > 0 && <span>{rejectedOrUnlocated} pair{rejectedOrUnlocated === 1 ? "" : "s"} non localisé{rejectedOrUnlocated === 1 ? "" : "s"} ou rejeté{rejectedOrUnlocated === 1 ? "" : "s"}</span>}
          {snapshot?.truncated === true && <span>Limite de télémétrie atteinte</span>}
        </div>
      </footer>

      <ul className="sly-map-sr-only" aria-label="Détails accessibles des pairs cartographiés">
        {peers.map((peer) => (
          <li key={`accessible-${peer.id}`}>
            {peer.label}, {locationText(peer)}, {peer.active
              ? `envoi ${formatRate(peer.rateUpload)}, réception ${formatRate(peer.rateDownload)}`
              : "inactif"}, torrent {peer.torrentName}{peer.encrypted ? ", liaison chiffrée" : ""}.
          </li>
        ))}
        {arcs.map((arc) => <li key={`arc-${arc.key}`}>{arcDescription(arc)}</li>)}
      </ul>
    </section>
  );
}

export default StrategicPeerMap;
