import assert from "node:assert/strict";
import test from "node:test";
import { locateSelfWithWindows, normalizeWindowsLocationPayload } from "../electron/local-location.mjs";

const CAPTURED_AT = "2026-08-19T15:30:00.000Z";

test("Windows Location est arrondi à 0,1 degré et marqué non persistant", () => {
  const result = normalizeWindowsLocationPayload({ status: "available", latitude: 48.8566, longitude: 2.3522, accuracyMeters: 37.8 }, CAPTURED_AT);
  assert.deepEqual(result, {
    status: "available",
    source: "windows-location-service",
    local: true,
    approximate: true,
    latitude: 48.9,
    longitude: 2.4,
    accuracyMeters: 38,
    capturedAt: CAPTURED_AT,
    persisted: false,
  });
});

test("une réponse Windows hors bornes devient indisponible et autorise le placement manuel", () => {
  const result = normalizeWindowsLocationPayload({ status: "available", latitude: 91, longitude: 2 }, CAPTURED_AT);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "invalid-response");
  assert.equal(result.manualPlacementAllowed, true);
  assert.equal(result.persisted, false);
});

test("locateSelf utilise uniquement le runner local injecté et valide son JSON", async () => {
  let calls = 0;
  const result = await locateSelfWithWindows({
    platform: "win32",
    clock: () => new Date(CAPTURED_AT),
    runner: async () => { calls += 1; return JSON.stringify({ status: "available", latitude: 43.6047, longitude: 1.4442, accuracyMeters: 500 }); },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "available");
  assert.equal(result.latitude, 43.6);
  assert.equal(result.longitude, 1.4);
});

test("aucun runner n'est appelé hors Windows", async () => {
  let calls = 0;
  const result = await locateSelfWithWindows({
    platform: "linux",
    clock: () => new Date(CAPTURED_AT),
    runner: async () => { calls += 1; return "{}"; },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "unsupported");
});

test("les erreurs et dépassements du runner ne divulguent aucun détail", async () => {
  const result = await locateSelfWithWindows({
    platform: "win32",
    clock: () => new Date(CAPTURED_AT),
    runner: async () => { throw Object.assign(new Error("coordonnée sensible"), { killed: true }); },
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "timeout");
  assert.doesNotMatch(JSON.stringify(result), /sensible/u);
});
