import assert from "node:assert/strict";
import test from "node:test";
import { PeerTelemetry } from "../electron/peer-telemetry.mjs";
import { TorrentService } from "../electron/torrent-service.mjs";

function fixtureTorrent() {
  return {
    id: 9,
    hash_string: "0123456789abcdef0123456789abcdef01234567",
    name: "Torrent de test",
    status: 4,
    percent_done: 0.5,
    metadata_percent_complete: 1,
    rate_download: 2_000,
    rate_upload: 500,
    eta: 30,
    upload_ratio: 0.25,
    uploaded_ever: 1_000,
    downloaded_ever: 4_000,
    seconds_seeding: 0,
    size_when_done: 8_000,
    peers_connected: 1,
    error_string: "",
    is_private: false,
    files: [],
    file_stats: [],
    trackers: [],
    peers: [{
      address: "8.8.8.8",
      port: 51_413,
      rate_to_client: 2_000,
      rate_to_peer: 500,
      progress: 0.75,
      is_encrypted: true,
      is_incoming: false,
    }],
  };
}

function harness() {
  const calls = [];
  const torrent = fixtureTorrent();
  const manager = {
    paths: { data: "C:\\quarantine" },
    rpc: { async call(method, params) { calls.push({ method, params }); return { torrents: [torrent] }; } },
  };
  const expectedLocation = Object.freeze({ status: "unavailable", reason: "disabled-or-denied", persisted: false });
  const service = new TorrentService({
    manager,
    audit: { append: async () => undefined },
    mediaVault: { revokeTorrent() {} },
    peerTelemetry: new PeerTelemetry({ secret: Buffer.alloc(32, 7), clock: () => 1_000, lookup: () => ({ country: "US", city: "Mountain View", ll: [37.4, -122.1] }), providerName: "fixture" }),
    selfLocator: async () => expectedLocation,
  });
  return { service, calls, expectedLocation };
}

test("TorrentService.list demande les pairs RPC réels sans exposer leur adresse", async () => {
  const { service, calls } = harness();
  const listed = await service.list();
  assert.equal(calls[0].method, "torrent_get");
  assert.equal(calls[0].params.fields.includes("peers"), true);
  assert.equal(listed[0].peers.length, 1);
  assert.equal(listed[0].peers[0].rateDownload, 2_000);
  assert.equal(listed[0].peers[0].rateUpload, 500);
  assert.doesNotMatch(JSON.stringify(listed), /8\.8\.8\.8|"address"|"port"/u);
});

test("peerSnapshot utilise un RPC minimal et renvoie un snapshot plat borné", async () => {
  const { service, calls } = harness();
  const snapshot = await service.peerSnapshot();
  assert.deepEqual(calls[0], { method: "torrent_get", params: { fields: ["id", "name", "peers"] } });
  assert.equal(snapshot.peers[0].torrentId, 9);
  assert.equal(snapshot.peers[0].torrentName, "Torrent de test");
  assert.equal(snapshot.counts.returned, 1);
  assert.equal(snapshot.geoProvider.offline, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /8\.8\.8\.8/u);
});

test("locateSelf délègue au service local explicite sans audit", async () => {
  const { service, expectedLocation } = harness();
  assert.equal(await service.locateSelf(), expectedLocation);
});
