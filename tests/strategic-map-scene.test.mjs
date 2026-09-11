import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { normalizeLocalNode, normalizePeers } from "../app/components/strategic-peer-map-model.mjs";
import { MAX_ANIMATED_ROUTES, SNAPSHOT_FRESHNESS_MS, buildMapRoutes, cityLabelKeys, clientToMap, createFlowCurve, fitMap, groupPeerCities, isSnapshotFresh, pointOnCurve, sampleRoute, signalStrength } from "../app/components/strategic-map-scene.mjs";

const rawPeer = (index, overrides = {}) => ({ id: `ScenePeer_${String(index).padStart(8, "0")}`, latitude: 48.8, longitude: 2.3, locationStatus: "resolved", city: "Paris", country: "France", countryCode: "FR", rateUpload: 4_000, rateDownload: 8_000, active: true, ...overrides });
const local = normalizeLocalNode({ source: "manual", latitude: 40, longitude: -10 });

test("les pairs d’une même zone sont regroupés sans compter deux fois un identifiant", () => {
  const peers = normalizePeers([rawPeer(1), rawPeer(1), rawPeer(2), rawPeer(3, { active: false })]);
  const [city] = groupPeerCities(peers);
  assert.equal(city.peers.length, 3);
  assert.equal(city.active, 2);
  assert.equal(city.upload, 8_000);
  assert.equal(city.download, 16_000);
  assert.equal(groupPeerCities(normalizePeers([rawPeer(1), rawPeer(2, { latitude: 49 })])).length, 2);
});

test("aucun tir sans base, débit positif ou télémétrie fraîche", () => {
  const cities = groupPeerCities(normalizePeers([rawPeer(1)]));
  assert.deepEqual(buildMapRoutes(cities, null, true), { routes: [], total: 0 });
  assert.deepEqual(buildMapRoutes(cities, local, false), { routes: [], total: 0 });
  assert.equal(buildMapRoutes(groupPeerCities(normalizePeers([rawPeer(1, { active: false })])), local, true).routes.length, 0);
  assert.equal(buildMapRoutes(groupPeerCities(normalizePeers([rawPeer(1, { rateUpload: 0, rateDownload: 0 })])), local, true).routes.length, 0);
  const now = Date.UTC(2026, 0, 1);
  assert.equal(isSnapshotFresh(new Date(now - SNAPSHOT_FRESHNESS_MS).toISOString(), now), true);
  assert.equal(isSnapshotFresh(new Date(now - SNAPSHOT_FRESHNESS_MS - 1).toISOString(), now), false);
  for (const invalid of [null, "", "invalide", 1, new Date(now + 60_000).toISOString()]) assert.equal(isSnapshotFresh(invalid, now), false);
});

test("les tirs bleus partent de la base et les rouges y arrivent, par deux arcs distincts", () => {
  const [city] = groupPeerCities(normalizePeers([rawPeer(1)]));
  const { routes } = buildMapRoutes([city], local, true);
  const up = routes.find((route) => route.kind === "upload");
  const down = routes.find((route) => route.kind === "download");
  assert.deepEqual(pointOnCurve(up.curve, 0), local.point);
  assert.deepEqual(pointOnCurve(up.curve, 1), city.point);
  assert.deepEqual(pointOnCurve(down.curve, 0), city.point);
  assert.deepEqual(pointOnCurve(down.curve, 1), local.point);
  assert.notDeepEqual(pointOnCurve(up.curve, .5), pointOnCurve(down.curve, .5));
  assert.ok(pointOnCurve(up.curve, .5).y < (local.point.y + city.point.y) / 2);
  const close = createFlowCurve(local.point, local.point, "upload");
  assert.doesNotMatch(close.path, /NaN|Infinity/);
});

test("intensité absolue, routes et particules restent bornées après une longue veille", () => {
  assert.equal(signalStrength(0), 0);
  assert.equal(signalStrength(Infinity), 0);
  assert.ok(signalStrength(1) < .001);
  assert.ok(signalStrength(16_000) < signalStrength(16_000_000));
  assert.equal(signalStrength(1e12), 1);
  const peers = normalizePeers(Array.from({ length: 512 }, (_, i) => rawPeer(i, { latitude: -80 + i % 160, longitude: -179 + i % 358, rateUpload: 4_000 + i * 1_000_000 })));
  const { routes, total } = buildMapRoutes(groupPeerCities(peers), local, true);
  assert.ok(total > MAX_ANIMATED_ROUTES);
  assert.equal(routes.length, MAX_ANIMATED_ROUTES);
  assert.ok(routes[0].rate >= routes.at(-1).rate);
  for (const seconds of [0, 1, 1e12, Infinity, -1]) {
    const samples = routes.flatMap((route) => sampleRoute(route, seconds));
    assert.ok(samples.length <= MAX_ANIMATED_ROUTES * 3);
    assert.ok(samples.every((sample) => sample.progress >= 0 && sample.progress <= 1));
  }
});

test("les déplacements et le zoom tiennent compte des marges de la carte", () => {
  assert.deepEqual(fitMap(1000, 520), { x: 0, y: 0, scale: 1 });
  assert.deepEqual(fitMap(500, 520), { x: 0, y: 130, scale: .5 });
  assert.deepEqual(clientToMap({ width: 500, height: 520, left: 10, top: 20 }, 260, 280), { x: 500, y: 260 });
  assert.deepEqual(clientToMap({ width: 2000, height: 520, left: 10, top: 20 }, 1010, 280), { x: 500, y: 260 });
});

test("les noms de zones ne recouvrent pas la base et restent en nombre limité", () => {
  const cities = groupPeerCities(normalizePeers(Array.from({ length: 512 }, (_, i) => rawPeer(i, { latitude: 60 - i % 100, longitude: -170 + i % 340 }))));
  const labels = cityLabelKeys(cities, { x: 0, y: 0, k: 1 }, null, local.point);
  assert.ok(labels.size <= 12);
  assert.equal(cityLabelKeys([{ ...cities[0], point: local.point }], { x: 0, y: 0, k: 1 }, null, local.point).size, 0);
});

test("le moteur visuel n’ouvre aucun accès réseau et libère les animations", async () => {
  const effects = await readFile(new URL("../app/components/StrategicMapEffects.tsx", import.meta.url), "utf8");
  const model = await readFile(new URL("../app/components/strategic-map-scene.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(`${effects}\n${model}`, /https?:\/\/|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
  for (const resource of ["cancelAnimationFrame", "resizeObserver.disconnect()", "intersection.disconnect()", "document.removeEventListener", "document.hidden", "reducedMotion"]) assert.ok(effects.includes(resource));
});
