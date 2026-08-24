import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharingHistory } from "../electron/sharing-history.mjs";

async function privateTemporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "secutorrent-sharing-history-test-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    assert.ok(resolved.startsWith(temporaryRoot), "la suppression reste confinée au dossier temporaire");
    await rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

function fakeManager(state) {
  return {
    rpc: {
      async call(method) {
        if (method === "torrent_get") return { torrents: state.torrents };
        if (method === "session_stats") return state.sessionStats;
        throw new Error(`RPC inattendu: ${method}`);
      },
    },
  };
}

test("l'historique agrège le partage sans conserver IP, tracker ou passkey", async (t) => {
  const directory = await privateTemporaryDirectory(t);
  const filePath = path.join(directory, "sharing-history.json");
  let now = new Date("2026-08-21T00:00:00.000Z");
  const state = {
    sessionStats: { cumulative_stats: { uploaded_bytes: 12_000_000 }, upload_speed: 0, active_torrent_count: 1 },
    torrents: [{
      id: 7,
      status: 6,
      percent_done: 1,
      uploaded_ever: 10_000_000,
      rate_upload: 0,
      peers_connected: 2,
      peers_getting_from_us: 0,
      tracker_stats: [{ announce: "https://tracker.invalid/announce?passkey=secret-value", leecher_count: 5 }],
      peers: [{
        address: "203.0.113.55",
        client_name: "secret-client-value",
        progress: 0.4,
        peer_is_interested: true,
        peer_is_choked: false,
      }],
    }],
  };
  const auditEvents = [];
  const history = await new SharingHistory({
    filePath,
    manager: fakeManager(state),
    audit: { async append(event, details) { auditEvents.push({ event, details }); } },
    clock: () => now,
  }).initialize();

  await history.record();
  now = new Date("2026-08-21T00:01:00.000Z");
  state.sessionStats = { cumulative_stats: { uploaded_bytes: 12_500_000 }, upload_speed: 100, active_torrent_count: 1 };
  state.torrents[0] = {
    ...state.torrents[0],
    uploaded_ever: 10_500_000,
    rate_upload: 100,
    peers_getting_from_us: 1,
  };
  await history.record();

  const summary = await history.summary(1);
  assert.equal(summary.sampleCount, 2);
  assert.equal(summary.observedSeconds, 60);
  assert.equal(summary.uploadedBytes, 500_000);
  assert.equal(summary.peakUploadRate, 100);
  assert.equal(summary.uploadActiveSeconds, 60);
  assert.equal(summary.connectedSeconds, 60);
  assert.equal(summary.peerDemandSeconds, 60);
  assert.equal(summary.trackerDemandSeconds, 60);
  assert.equal(summary.maxInterestedPeers, 1);
  assert.equal(summary.maxServedPeers, 1);
  assert.deepEqual(summary.byTorrent, [{ id: 7, uploadedBytes: 500_000 }]);
  assert.deepEqual(auditEvents, []);

  const stored = await readFile(filePath, "utf8");
  assert.doesNotMatch(stored, /203\.0\.113\.55|secret-client-value|tracker\.invalid|secret-value/u);
  assert.equal(JSON.parse(stored).samples.length, 2);
});

test("l'historique évite les doublons rapprochés et réinitialise un format invalide", async (t) => {
  const directory = await privateTemporaryDirectory(t);
  const filePath = path.join(directory, "sharing-history.json");
  await writeFile(filePath, "{\"schemaVersion\":999,\"samples\":[]}", "utf8");
  const auditEvents = [];
  let now = new Date("2026-08-21T04:00:00.000Z");
  const state = { sessionStats: {}, torrents: [] };
  const history = await new SharingHistory({
    filePath,
    manager: fakeManager(state),
    audit: { async append(event, details) { auditEvents.push({ event, details }); } },
    clock: () => now,
  }).initialize();

  await history.record();
  now = new Date("2026-08-21T04:00:20.000Z");
  await history.record();
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).samples.length, 1);
  assert.deepEqual(auditEvents, [{ event: "sharing.history_reset", details: { reason: "FORMAT_INVALID" } }]);
});
