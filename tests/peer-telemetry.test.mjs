import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PEERS_PER_TORRENT,
  MAX_PEERS_TOTAL,
  PeerTelemetry,
  approximateLocalLocation,
  isGlobalUnicastAddress,
} from "../electron/peer-telemetry.mjs";

const SECRET = Buffer.alloc(32, 0x53);

function rawPeer(address, overrides = {}) {
  return {
    address,
    port: 51_413,
    rate_to_client: 12_345,
    rate_to_peer: 0,
    progress: 0.42,
    is_encrypted: true,
    is_incoming: true,
    ...overrides,
  };
}

test("seules les adresses IP globales non mappées passent le filtre", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isGlobalUnicastAddress(address), true, address);
  }
  for (const address of [
    "0.0.0.1", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1",
    "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "2001::1", "2002:c000:0201::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:0808:0808", "8.8.8.8%4", "not-an-ip",
  ]) {
    assert.equal(isGlobalUnicastAddress(address), false, address);
  }
});

test("un pair actif est anonymisé, géolocalisé hors ligne et typé depuis les champs RPC Transmission", () => {
  const lookedUp = [];
  const telemetry = new PeerTelemetry({
    secret: SECRET,
    clock: () => 1_800_000,
    providerName: "fixture",
    lookup(address) {
      lookedUp.push(address);
      return { country: "FR", city: "Par\u202eis", ll: [48.8566, 2.3522] };
    },
  });
  const snapshot = telemetry.snapshot([{ id: 7, name: "Démo", peers: [rawPeer("8.8.8.8", { rate_to_peer: 321 })] }]);
  const peer = snapshot.peers[0];

  assert.deepEqual(lookedUp, ["8.8.8.8"]);
  assert.match(peer.id, /^[A-Za-z0-9_-]{16}$/u);
  assert.equal(peer.label, `Pair ${peer.id.slice(0, 6)}`);
  assert.equal(peer.torrentId, 7);
  assert.equal(peer.torrentName, "Démo");
  assert.equal(peer.countryCode, "FR");
  assert.equal(peer.country, "France");
  assert.equal(peer.city, "Paris");
  assert.equal(peer.latitude, 48.8566);
  assert.equal(peer.longitude, 2.3522);
  assert.equal(peer.locationStatus, "resolved");
  assert.equal(peer.rateDownload, 12_345);
  assert.equal(peer.rateUpload, 321);
  assert.equal(peer.progress, 0.42);
  assert.equal(peer.active, true);
  assert.equal(peer.encrypted, true);
  assert.equal(peer.connection, "incoming");
  assert.equal(peer.direction, "bidirectional");
  assert.doesNotMatch(JSON.stringify(snapshot), /8\.8\.8\.8|address|port/iu);
});

test("les identifiants sont stables dans une fenêtre courte puis tournent sans persistance", () => {
  let now = 1_000;
  const telemetry = new PeerTelemetry({ secret: SECRET, clock: () => now });
  const torrents = [{ id: 1, name: "Test", peers: [rawPeer("1.1.1.1")] }];
  const first = telemetry.snapshot(torrents).peers[0].id;
  now += 60_000;
  const shortlyAfter = telemetry.snapshot(torrents).peers[0].id;
  now += 16 * 60_000;
  const later = telemetry.snapshot(torrents).peers[0].id;
  assert.equal(shortlyAfter, first);
  assert.notEqual(later, first);
});

test("les pairs connectés inactifs restent des points, tandis que les entrées malformées et privées sont éliminées", () => {
  let lookups = 0;
  const telemetry = new PeerTelemetry({
    secret: SECRET,
    lookup() { lookups += 1; return { country: "US", city: "X", ll: [1, 2] }; },
  });
  const peers = [
    rawPeer("10.0.0.1"),
    rawPeer("::ffff:0808:0808"),
    rawPeer("8.8.8.8", { rate_to_client: 0, rate_to_peer: 0 }),
    rawPeer("8.8.4.4", { rate_to_client: "999" }),
    rawPeer("9.9.9.9", { rate_to_client: 1_000_000_000_001 }),
    rawPeer("1.0.0.1", { progress: 2 }),
  ];
  const snapshot = telemetry.snapshot([{ id: 1, name: "Test", peers }]);
  assert.equal(snapshot.peers.length, 1);
  assert.equal(snapshot.peers[0].active, false);
  assert.equal(snapshot.peers[0].direction, "inactive");
  assert.equal(snapshot.counts.active, 0);
  assert.equal(snapshot.counts.filtered, peers.length - 1);
  assert.equal(lookups, 1);
});

test("les plafonds anti-DoS bornent chaque torrent et le snapshot global", () => {
  const telemetry = new PeerTelemetry({ secret: SECRET });
  const torrents = Array.from({ length: 5 }, (_, torrentIndex) => ({
    id: torrentIndex,
    name: `Torrent ${torrentIndex}`,
    peers: Array.from({ length: 200 }, (_, peerIndex) => rawPeer(`11.${torrentIndex}.${Math.floor(peerIndex / 255)}.${peerIndex % 255}`, { port: peerIndex })),
  }));
  const normalized = telemetry.normalizeTorrents(torrents);
  assert.equal(normalized.flatPeers.length, MAX_PEERS_TOTAL);
  assert.equal(normalized.peersByTorrentId.get(0).length, MAX_PEERS_PER_TORRENT);
  assert.equal(normalized.counts.observed, 1_000);
  assert.equal(normalized.counts.active, 1_000);
  assert.equal(normalized.truncated, true);
});

test("une réponse GeoIP imprécise n'invente pas de coordonnées", () => {
  const telemetry = new PeerTelemetry({
    secret: SECRET,
    lookup: () => ({ country: "ZZ", city: "A".repeat(1_000), ll: [999, Number.NaN] }),
  });
  const peer = telemetry.snapshot([{ id: 1, name: "Test", peers: [rawPeer("8.8.8.8")] }]).peers[0];
  assert.equal(peer.city, null);
  assert.equal(peer.latitude, null);
  assert.equal(peer.longitude, null);
  assert.equal(peer.locationStatus, "unavailable");
});

test("une base GeoIP locale malformée ne peut pas réinjecter une IP dans le champ ville", () => {
  const telemetry = new PeerTelemetry({
    secret: SECRET,
    lookup: (address) => ({ country: "US", city: `Nœud ${address}`, ll: [37.4, -122.1] }),
  });
  const snapshot = telemetry.snapshot([{ id: 1, name: "Test", peers: [rawPeer("8.8.8.8")] }]);
  assert.equal(snapshot.peers[0].city, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /8\.8\.8\.8/u);
});

test("le fuseau local ne devient jamais une fausse position cartographique", () => {
  assert.deepEqual(approximateLocalLocation("Europe/Paris"), {
    status: "unavailable",
    source: "none",
    approximate: true,
    local: true,
    timeZone: "Europe/Paris",
    latitude: null,
    longitude: null,
    reason: "explicit-location-required",
    manualPlacementAllowed: true,
    persisted: false,
  });
});
