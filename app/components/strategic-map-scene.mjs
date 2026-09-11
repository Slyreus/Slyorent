import { MAP_HEIGHT, MAP_WIDTH, MAX_RENDERED_PEERS } from "./strategic-peer-map-model.mjs";

export const MAX_ANIMATED_ROUTES = 64;
export const SNAPSHOT_FRESHNESS_MS = 8_000;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function isSnapshotFresh(capturedAt, now) {
  const timestamp = typeof capturedAt === "string" ? Date.parse(capturedAt) : NaN;
  return Number.isFinite(timestamp) && Number.isFinite(now) && now - timestamp >= -5_000 && now - timestamp <= SNAPSHOT_FRESHNESS_MS;
}

// Les coordonnées GeoIP sont des centres de zones, pas des adresses de pairs.
export function groupPeerCities(peers) {
  const groups = new Map();
  for (const peer of peers.slice(0, MAX_RENDERED_PEERS)) {
    const key = `${peer.latitude.toFixed(2)}:${peer.longitude.toFixed(2)}:${peer.countryCode || ""}`;
    let city = groups.get(key);
    if (!city) {
      city = { key, point: peer.point, name: peer.city || peer.country || "Zone inconnue", country: peer.country, peers: [], active: 0, upload: 0, download: 0 };
      groups.set(key, city);
    }
    city.peers.push(peer);
    if (peer.active) {
      city.active += 1;
      city.upload += peer.rateUpload;
      city.download += peer.rateDownload;
    }
  }
  return [...groups.values()].sort((a, b) => b.upload + b.download - a.upload - a.download || a.key.localeCompare(b.key));
}

export function signalStrength(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  // Échelle absolue logarithmique : un pair à 1 o/s n'éclaire pas toute la carte.
  return clamp(Math.log2(1 + rate / 8_192) / 13, 0, 1);
}

function seedOf(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0) / 4_294_967_296;
}

export function createFlowCurve(local, remote, kind) {
  const dx = remote.x - local.x;
  const dy = remote.y - local.y;
  const distance = Math.hypot(dx, dy);
  const side = kind === "upload" ? 1 : -1;
  const lift = clamp(distance * .44, 30, 175);
  const control = {
    x: (local.x + remote.x) / 2 + side * clamp(distance * .07, 12, 40),
    y: (local.y + remote.y) / 2 - lift + side * 10,
  };
  const from = kind === "upload" ? local : remote;
  const to = kind === "upload" ? remote : local;
  return { from, control, to, path: `M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}` };
}

export function pointOnCurve(curve, progress) {
  const t = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  const inverse = 1 - t;
  return {
    x: inverse * inverse * curve.from.x + 2 * inverse * t * curve.control.x + t * t * curve.to.x,
    y: inverse * inverse * curve.from.y + 2 * inverse * t * curve.control.y + t * t * curve.to.y,
  };
}

export function buildMapRoutes(cities, local, fresh) {
  if (!local || !fresh) return { routes: [], total: 0 };
  const routes = [];
  for (const city of cities) {
    for (const kind of ["upload", "download"]) {
      const rate = city[kind];
      if (rate <= 0) continue;
      const strength = signalStrength(rate);
      routes.push({
        key: `${city.key}:${kind}`, cityKey: city.key, kind, rate, strength,
        curve: createFlowCurve(local.point, city.point, kind),
        seed: seedOf(`${city.key}:${kind}`),
        duration: 3.4 - strength * 1.75,
        pulses: 1 + Math.floor(strength * 2.99),
      });
    }
  }
  routes.sort((a, b) => b.rate - a.rate || a.key.localeCompare(b.key));
  return { routes: routes.slice(0, MAX_ANIMATED_ROUTES), total: routes.length };
}

// Animation décorative sans file de particules : aucune rafale de rattrapage
// au retour d'une veille, et au plus 3 tirs par route, quelle que soit sa durée.
export function sampleRoute(route, seconds) {
  const clock = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const cycle = route.duration + .85;
  const samples = [];
  for (let index = 0; index < route.pulses; index += 1) {
    const phase = (clock + route.seed * cycle + index * cycle / route.pulses) % cycle;
    if (phase < route.duration) samples.push({ type: "flight", progress: phase / route.duration });
    else samples.push({ type: "impact", progress: (phase - route.duration) / .85 });
  }
  return samples;
}

export function fitMap(width, height) {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : MAP_WIDTH;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : MAP_HEIGHT;
  const scale = Math.min(safeWidth / MAP_WIDTH, safeHeight / MAP_HEIGHT);
  return { scale, x: (safeWidth - MAP_WIDTH * scale) / 2, y: (safeHeight - MAP_HEIGHT * scale) / 2 };
}

export function clientToMap(bounds, clientX, clientY) {
  const fit = fitMap(bounds.width, bounds.height);
  return { x: (clientX - bounds.left - fit.x) / fit.scale, y: (clientY - bounds.top - fit.y) / fit.scale };
}

export function cityLabelKeys(cities, viewport, selectedKey, localPoint) {
  const occupied = localPoint ? [{ x: localPoint.x * viewport.k + viewport.x, y: localPoint.y * viewport.k + viewport.y, width: 120 }] : [];
  const visible = new Set();
  const ordered = [...cities].sort((a, b) => Number(b.key === selectedKey) - Number(a.key === selectedKey));
  for (const city of ordered) {
    const x = city.point.x * viewport.k + viewport.x;
    const y = city.point.y * viewport.k + viewport.y;
    const width = clamp(city.name.length * 6 + 22, 70, 160);
    if (x < 20 || x > MAP_WIDTH - width || y < 65 || y > MAP_HEIGHT - 48) continue;
    if (city.key !== selectedKey && occupied.some((point) => Math.abs(point.y - y) < 27 && x < point.x + point.width && x + width > point.x)) continue;
    visible.add(city.key);
    occupied.push({ x, y, width });
    if (visible.size >= 12) break;
  }
  return visible;
}
