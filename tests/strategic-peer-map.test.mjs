import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  MAP_HEIGHT,
  MAP_WIDTH,
  MAX_RENDERED_PEERS,
  centerViewport,
  clampViewport,
  createArcPath,
  normalizeLocalNode,
  normalizePeers,
  projectCoordinate,
  rateVisual,
  safeDisplayText,
  zoomViewport,
} from "../app/components/strategic-peer-map-model.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const componentPath = path.join(repositoryRoot, "app", "components", "StrategicPeerMap.tsx");
const cssPath = path.join(repositoryRoot, "app", "components", "StrategicPeerMap.css");
const geometryPath = path.join(repositoryRoot, "app", "components", "world-land-110m.ts");
const licensePath = path.join(repositoryRoot, "app", "components", "WORLD_GEOMETRY_LICENSE.md");

function peer(overrides = {}) {
  return {
    id: "AbCdEfGhIjKlMnOp",
    label: "Pair forgé",
    torrentId: 7,
    torrentName: "Torrent test",
    countryCode: "FR",
    country: "France",
    city: "Paris",
    latitude: 48.8,
    longitude: 2.3,
    locationStatus: "resolved",
    rateDownload: 12_000,
    rateUpload: 4_000,
    active: true,
    progress: 0.5,
    encrypted: true,
    connection: "outgoing",
    direction: "bidirectional",
    ...overrides,
  };
}

test("la projection locale refuse les coordonnées invalides et reste bornée", () => {
  assert.deepEqual(projectCoordinate(90, -180), { x: 0, y: 0 });
  assert.deepEqual(projectCoordinate(-90, 180), { x: MAP_WIDTH, y: MAP_HEIGHT });
  assert.deepEqual(projectCoordinate(0, 0), { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 });
  for (const [latitude, longitude] of [[91, 0], [-91, 0], [0, 181], [0, -181], [Number.NaN, 0], [0, Infinity], ["48", 2]]) {
    assert.equal(projectCoordinate(latitude, longitude), null);
  }
});

test("seules les positions Windows ou manuelles explicites peuvent ancrer la carte", () => {
  assert.equal(normalizeLocalNode({ source: "timezone", latitude: 48.8566, longitude: 2.3522 }), null);
  assert.equal(normalizeLocalNode({ source: "none", latitude: null, longitude: null }), null);
  assert.equal(normalizeLocalNode({ source: "browser", latitude: 10, longitude: 10 }), null);

  const windows = normalizeLocalNode({
    source: "windows-location-service",
    latitude: 48.8,
    longitude: 2.3,
    accuracyMeters: 1_250,
    address: "203.0.113.42",
  });
  assert.equal(windows.source, "windows-location-service");
  assert.equal(windows.accuracyKm, 1.25);
  assert.equal("address" in windows, false);

  const manual = normalizeLocalNode({ source: "manual", latitude: -12, longitude: 80, accuracyKm: 4 });
  assert.equal(manual.source, "manual");
  assert.equal(manual.accuracyKm, 4);
});

test("la télémétrie rend au plus 512 pairs et conserve les points inactifs sans flux", () => {
  const source = Array.from({ length: 540 }, (_, index) => peer({
    id: `PeerToken_${index.toString(36).padStart(12, "0")}`,
    active: false,
    direction: "inactive",
    rateDownload: 0,
    rateUpload: 0,
    longitude: -170 + (index % 340),
  }));
  const normalized = normalizePeers(source);
  assert.equal(normalized.length, MAX_RENDERED_PEERS);
  assert.ok(normalized.every((item) => item.active === false && item.direction === "inactive"));
  assert.ok(normalized.every((item) => item.rateDownload === 0 && item.rateUpload === 0));
});

test("les pairs non résolus ou malformés sont éliminés et les valeurs numériques sont bornées", () => {
  const normalized = normalizePeers([
    peer({ locationStatus: "unavailable" }),
    peer({ id: "8.8.8.8", latitude: 10 }),
    peer({ id: "SafePeerToken001", latitude: 200 }),
    peer({ id: "SafePeerToken002", rateDownload: -10, rateUpload: 2_000_000_000_000, progress: 8 }),
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].rateDownload, 0);
  assert.equal(normalized[0].rateUpload, 1_000_000_000_000);
  assert.equal(normalized[0].progress, 1);
  assert.equal(normalized[0].active, true);
  assert.equal(normalized[0].direction, "upload");
});

test("aucune propriété non autorisée ni adresse brute ne traverse le modèle renderer", () => {
  const raw = peer({
    id: "SafePeerToken003",
    label: "Pair 198.51.100.77",
    city: "Nœud 203.0.113.8",
    country: "Région 2001:db8::42",
    torrentName: "Copie ::ffff:192.0.2.9",
    address: "198.51.100.77",
    clientName: "Client 2001:db8::99",
    port: 51_413,
  });
  const [normalized] = normalizePeers([raw]);
  const serialized = JSON.stringify(normalized);
  assert.equal(normalized.label, "Pair SafePe");
  assert.doesNotMatch(serialized, /198\.51\.100\.77|203\.0\.113\.8|2001:db8::42|::ffff:192\.0\.2\.9|2001:db8::99/iu);
  for (const forbidden of ["address", "clientName", "port", "label"]) {
    if (forbidden === "label") continue;
    assert.equal(Object.hasOwn(normalized, forbidden), false, forbidden);
  }
  assert.equal(safeDisplayText("Paris\u202e 203.0.113.9"), "Paris [adresse masquée]");
});

test("les arcs et leur intensité restent finis même aux bornes", () => {
  const pathValue = createArcPath({ x: 10, y: 15 }, { x: 960, y: 500 }, -1);
  assert.match(pathValue, /^M [-\d.]+ [-\d.]+ Q [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+$/u);
  assert.doesNotMatch(pathValue, /NaN|Infinity/u);
  assert.equal(createArcPath({ x: Number.NaN, y: 0 }, { x: 1, y: 1 }), null);

  const slow = rateVisual(1, 1_000_000);
  const fast = rateVisual(1_000_000, 1_000_000);
  assert.ok(fast.strokeWidth > slow.strokeWidth);
  assert.ok(fast.opacity > slow.opacity);
  assert.ok(fast.durationSeconds < slow.durationSeconds);
  for (const visual of [slow, fast, rateVisual(Infinity, Infinity)]) {
    assert.ok(Number.isFinite(visual.strokeWidth));
    assert.ok(Number.isFinite(visual.opacity));
    assert.ok(Number.isFinite(visual.durationSeconds));
  }
});

test("pan, zoom et recentrage restent dans le monde embarqué", () => {
  assert.deepEqual(clampViewport({ x: 1_000, y: -9_000, k: 99 }), { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 - MAP_HEIGHT * 6, k: 6 });
  assert.deepEqual(zoomViewport({ x: 0, y: 0, k: 1 }, 2, { x: 500, y: 260 }), { x: -500, y: -260, k: 2 });

  const localPoint = projectCoordinate(48.8, 2.3);
  const centered = centerViewport(localPoint, 1.6);
  assert.equal(centered.k, 1.6);
  assert.deepEqual(centered, clampViewport({
    x: MAP_WIDTH / 2 - localPoint.x * 1.6,
    y: MAP_HEIGHT / 2 - localPoint.y * 1.6,
    k: 1.6,
  }));
  assert.ok(Math.abs(centered.x + localPoint.x * centered.k - MAP_WIDTH / 2) < 0.000_001);
  assert.ok(Math.abs(centered.y + localPoint.y * centered.k - MAP_HEIGHT / 2) < 0.000_001);
  assert.deepEqual(centerViewport(null), { x: 0, y: 0, k: 1 });
});

test("le composant et la géométrie n'embarquent aucun client ou fond de carte réseau", async () => {
  const [component, css, geometry, license, packageJson] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(cssPath, "utf8"),
    readFile(geometryPath, "utf8"),
    readFile(licensePath, "utf8"),
    readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ]);
  const rendererSources = `${component}\n${css}\n${geometry}`;
  assert.match(component, /WORLD_LAND_PATH/u);
  assert.match(component, /Données GeoLite2 © MaxMind, géolocalisation approximative/u);
  assert.match(component, /onRequestLocation/u);
  assert.match(component, /centerViewport\(\{ x: localX, y: localY \}, 1\.6\)/u);
  assert.match(css, /prefers-reduced-motion:\s*reduce/u);
  assert.match(license, /Natural Earth geometry is\s*\n?public domain/iu);
  assert.ok(geometry.length > 50_000, "la géométrie terrestre locale doit être substantielle");
  assert.doesNotMatch(rendererSources, /https?:\/\//iu);
  assert.doesNotMatch(rendererSources, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u);
  assert.doesNotMatch(rendererSources, /navigator\.geolocation|tile\.openstreetmap|mapbox|leaflet/iu);
  assert.doesNotMatch(component, /window\.secuTorrent\.locateSelf/u);
  assert.doesNotMatch(packageJson, /"(?:world-atlas|topojson-client|leaflet|mapbox-gl)"\s*:/u);
});
