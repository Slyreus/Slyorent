export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 520;
export const MAX_RENDERED_PEERS = 512;

const MAX_RATE_BYTES_PER_SECOND = 1_000_000_000_000;
const MAX_INPUT_PEERS = 2_048;
const CONTROL_OR_BIDI = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu;
const IPV4_TEXT = /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/gu;
const IPV6_TEXT = /(?<![0-9a-f:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![0-9a-f:])/giu;
const SAFE_EPHEMERAL_ID = /^[A-Za-z0-9_-]{12,64}$/u;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function redactNetworkIdentifiers(value) {
  return value.replace(IPV4_TEXT, "[adresse masquée]").replace(IPV6_TEXT, "[adresse masquée]");
}

export function safeDisplayText(value, maximumLength = 96) {
  if (typeof value !== "string" || !Number.isInteger(maximumLength) || maximumLength < 1 || maximumLength > 512) return null;
  if (value.length > maximumLength * 8) return null;
  const text = redactNetworkIdentifiers(value.normalize("NFKC").replace(CONTROL_OR_BIDI, "")).trim().slice(0, maximumLength).trim();
  return text || null;
}

export function projectCoordinate(latitude, longitude) {
  const lat = finiteNumber(latitude);
  const lon = finiteNumber(longitude);
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return Object.freeze({
    x: ((lon + 180) / 360) * MAP_WIDTH,
    y: ((90 - lat) / 180) * MAP_HEIGHT,
  });
}

export function normalizeLocalNode(value) {
  const input = record(value);
  if (!input) return null;
  if (input.source !== "windows-location-service" && input.source !== "manual") return null;
  const point = projectCoordinate(input.latitude, input.longitude);
  if (!point) return null;

  const source = input.source === "windows-location-service"
    ? "windows-location-service"
    : "manual";
  const accuracyKmInput = finiteNumber(input.accuracyKm);
  const accuracyMetersInput = finiteNumber(input.accuracyMeters);
  const accuracyKm = accuracyKmInput !== null && accuracyKmInput >= 0
    ? clamp(accuracyKmInput, 0, 20_000)
    : accuracyMetersInput !== null && accuracyMetersInput >= 0
      ? clamp(accuracyMetersInput / 1_000, 0, 20_000)
      : null;

  return Object.freeze({
    latitude: input.latitude,
    longitude: input.longitude,
    point,
    source,
    accuracyKm,
    approximate: input.approximate !== false,
  });
}

function normalizeRate(value) {
  const rate = finiteNumber(value);
  return rate === null ? 0 : Math.trunc(clamp(rate, 0, MAX_RATE_BYTES_PER_SECOND));
}

function normalizeProgress(value) {
  const progress = finiteNumber(value);
  return progress === null ? 0 : clamp(progress, 0, 1);
}

function normalizePeer(value) {
  const input = record(value);
  if (!input || input.locationStatus !== "resolved" || typeof input.id !== "string" || !SAFE_EPHEMERAL_ID.test(input.id)) return null;
  const point = projectCoordinate(input.latitude, input.longitude);
  if (!point) return null;
  const rateDownload = normalizeRate(input.rateDownload);
  const rateUpload = normalizeRate(input.rateUpload);
  const active = input.active === false ? false : rateDownload > 0 || rateUpload > 0;

  const id = input.id.slice(0, 64);
  const countryCode = typeof input.countryCode === "string" && /^[A-Za-z]{2}$/u.test(input.countryCode)
    ? input.countryCode.toUpperCase()
    : null;
  const torrentId = Number.isInteger(input.torrentId) && input.torrentId >= 0 && input.torrentId <= 2_147_483_647
    ? input.torrentId
    : null;

  return Object.freeze({
    id,
    label: `Pair ${id.slice(0, 6)}`,
    torrentId,
    torrentName: safeDisplayText(input.torrentName, 160) || "Torrent sans nom",
    countryCode,
    country: safeDisplayText(input.country, 96),
    city: safeDisplayText(input.city, 96),
    latitude: input.latitude,
    longitude: input.longitude,
    point,
    rateDownload,
    rateUpload,
    active,
    progress: normalizeProgress(input.progress),
    encrypted: input.encrypted === true,
    connection: input.connection === "incoming" ? "incoming" : "outgoing",
    direction: !active ? "inactive" : rateDownload > 0 && rateUpload > 0 ? "bidirectional" : rateDownload > 0 ? "download" : "upload",
  });
}

export function normalizePeers(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const peers = [];
  for (const item of value.slice(0, MAX_INPUT_PEERS)) {
    const peer = normalizePeer(item);
    if (peer) peers.push(peer);
    if (peers.length === MAX_RENDERED_PEERS) break;
  }
  return Object.freeze(peers);
}

export function rateVisual(rate, maximumRate) {
  const boundedRate = normalizeRate(rate);
  const boundedMaximum = Math.max(1, normalizeRate(maximumRate), boundedRate);
  if (boundedRate === 0) return Object.freeze({ strokeWidth: 0, opacity: 0, durationSeconds: 4.8 });
  const intensity = clamp(Math.log1p(boundedRate) / Math.log1p(boundedMaximum), 0, 1);
  return Object.freeze({
    strokeWidth: 1.15 + intensity * 4.35,
    opacity: 0.32 + intensity * 0.62,
    durationSeconds: 4.6 - intensity * 3.35,
  });
}

function validPoint(value) {
  const input = record(value);
  const x = finiteNumber(input?.x);
  const y = finiteNumber(input?.y);
  return x === null || y === null ? null : { x, y };
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

export function createArcPath(from, to, bendSign = 1) {
  const start = validPoint(from);
  const end = validPoint(to);
  if (!start || !end) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const sign = bendSign < 0 ? -1 : 1;
  const lift = clamp(distance * 0.24, 22, 135) * sign;
  const normalX = distance > 0.5 ? -dy / distance : 0;
  const normalY = distance > 0.5 ? dx / distance : -1;
  const controlX = (start.x + end.x) / 2 + normalX * lift;
  const controlY = (start.y + end.y) / 2 + normalY * lift;
  return `M ${rounded(start.x)} ${rounded(start.y)} Q ${rounded(controlX)} ${rounded(controlY)} ${rounded(end.x)} ${rounded(end.y)}`;
}

export function clampViewport(value) {
  const input = record(value) || {};
  const k = clamp(finiteNumber(input.k) ?? 1, 1, 6);
  // Autorise une marge d'océan afin que n'importe quel point réel puisse être
  // placé exactement au centre, tout en gardant au moins un bord du monde à
  // l'intérieur de la moitié centrale du viewport.
  const x = clamp(finiteNumber(input.x) ?? 0, MAP_WIDTH / 2 - MAP_WIDTH * k, MAP_WIDTH / 2);
  const y = clamp(finiteNumber(input.y) ?? 0, MAP_HEIGHT / 2 - MAP_HEIGHT * k, MAP_HEIGHT / 2);
  return Object.freeze({ x, y, k });
}

export function centerViewport(point, scale = 1.6) {
  const target = validPoint(point);
  if (!target) return clampViewport({ x: 0, y: 0, k: 1 });
  const k = clamp(finiteNumber(scale) ?? 1.6, 1, 6);
  return clampViewport({
    x: MAP_WIDTH / 2 - target.x * k,
    y: MAP_HEIGHT / 2 - target.y * k,
    k,
  });
}

export function zoomViewport(viewport, nextScale, anchor = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 }) {
  const current = clampViewport(viewport);
  const targetScale = clamp(finiteNumber(nextScale) ?? current.k, 1, 6);
  const safeAnchor = validPoint(anchor) || { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
  const worldX = (safeAnchor.x - current.x) / current.k;
  const worldY = (safeAnchor.y - current.y) / current.k;
  return clampViewport({
    x: safeAnchor.x - worldX * targetScale,
    y: safeAnchor.y - worldY * targetScale,
    k: targetScale,
  });
}

export function formatRate(value) {
  const rate = normalizeRate(value);
  if (rate < 1_000) return `${rate} o/s`;
  if (rate < 1_000_000) return `${(rate / 1_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} ko/s`;
  if (rate < 1_000_000_000) return `${(rate / 1_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo/s`;
  return `${(rate / 1_000_000_000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Go/s`;
}
