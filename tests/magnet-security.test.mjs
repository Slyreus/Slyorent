import assert from "node:assert/strict";
import dns from "node:dns/promises";
import test from "node:test";
import {
  assertSafeMagnetNetworkTargets,
  assertSafeTrackerUrls,
  inspectMagnet,
} from "../electron/magnet-security.mjs";

const HASH = "0123456789abcdef0123456789abcdef01234567";

function magnetWithTracker(tracker) {
  const params = new URLSearchParams({
    xt: `urn:btih:${HASH}`,
    dn: "Film autorisé",
    tr: tracker,
  });
  return `magnet:?${params}`;
}

test("l'inspection accepte un magnet strict et n'expose que l'hôte du tracker", () => {
  const inspection = inspectMagnet(magnetWithTracker("https://tracker.example/announce"));
  assert.equal(inspection.valid, true);
  assert.equal(inspection.verdict, "clean");
  assert.equal(inspection.hash, HASH);
  assert.deepEqual(inspection.trackers, ["tracker.example"]);
});

test("les paramètres de sources Web et les identifiants de tracker sont bloqués", () => {
  const webSeed = inspectMagnet(`${magnetWithTracker("https://tracker.example/announce")}&ws=${encodeURIComponent("https://cdn.example/file")}`);
  assert.equal(webSeed.valid, false);
  assert.match(webSeed.issues.join(" "), /Paramètre réseau interdit/u);

  const credentials = inspectMagnet(magnetWithTracker("https://user:password@tracker.example/announce"));
  assert.equal(credentials.valid, false);
  assert.match(credentials.issues.join(" "), /identifiants/u);
});

test("un tracker pointant directement vers la boucle locale est refusé avant ajout", async () => {
  const localMagnet = magnetWithTracker("http://127.0.0.1:8080/announce");
  assert.equal(inspectMagnet(localMagnet).valid, false);
  await assert.rejects(assertSafeMagnetNetworkTargets(localMagnet), /réseau local ou réservé/u);
  await assert.rejects(assertSafeTrackerUrls(["udp://10.1.2.3:6969/announce"]), /réseau local ou réservé/u);
  const mappedLoopback = magnetWithTracker("http://[::ffff:127.0.0.1]:8080/announce");
  assert.equal(inspectMagnet(mappedLoopback).valid, false);
  await assert.rejects(assertSafeTrackerUrls(["udp://[::ffff:7f00:1]:6969/announce"]), /réseau local ou réservé/u);
});

test("une adresse IPv6 globale reste autorisée", () => {
  const inspection = inspectMagnet(magnetWithTracker("https://[2606:4700:4700::1111]/announce"));
  assert.equal(inspection.valid, true);
  assert.deepEqual(inspection.trackers, ["2606:4700:4700::1111"]);
});

test("une liste de trackers surdimensionnée est refusée sans résolution DNS", async () => {
  await assert.rejects(assertSafeTrackerUrls(Array.from({ length: 65 }, () => "https://tracker.example/announce")), /Liste de trackers invalide/u);
});

test("une réponse DNS IPv6 mappée vers une IPv4 privée reste bloquée", async () => {
  const originalLookup = dns.lookup;
  dns.lookup = async () => [{ address: "::ffff:7f00:1", family: 6 }];
  try {
    await assert.rejects(
      assertSafeTrackerUrls(["https://tracker.example/announce"]),
      /réseau local ou réservé/u,
    );
  } finally {
    dns.lookup = originalLookup;
  }
});
