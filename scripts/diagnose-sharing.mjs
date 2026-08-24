import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { TransmissionRpcClient } from "../electron/transmission-rpc.mjs";

function trackerHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return "invalid";
  }
}

function cleanTrackerResult(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/giu, "[redacted-url]")
    .replace(/[a-f\d]{24,}/giu, "[redacted-secret]")
    .slice(0, 180);
}

const profilePath = path.join(process.env.APPDATA || "", "SecuTorrent Slyorus", "engine-profile", "settings.json");
const settings = JSON.parse(await readFile(profilePath, "utf8"));
const rpc = new TransmissionRpcClient({
  port: settings["rpc-port"] ?? settings.rpc_port,
  username: settings["rpc-username"] ?? settings.rpc_username,
  password: settings["rpc-password"] ?? settings.rpc_password,
});

const fields = [
  "id", "name", "status", "percent_done", "rate_upload", "uploaded_ever", "downloaded_ever",
  "upload_ratio", "seconds_seeding", "peers_connected", "peers_getting_from_us", "peers_sending_to_us",
  "is_private", "upload_limited", "upload_limit", "seed_ratio_mode", "seed_ratio_limit",
  "seed_idle_mode", "seed_idle_limit", "tracker_stats",
];

const [{ torrents = [] }, session, stats, port] = await Promise.all([
  rpc.call("torrent_get", { fields }),
  rpc.call("session_get", {}),
  rpc.call("session_stats", {}),
  rpc.call("port_test", {}).catch((error) => ({ error: cleanTrackerResult(error?.message) })),
]);

const report = {
  capturedAt: new Date().toISOString(),
  torrents: torrents.map((torrent) => ({
    id: torrent.id,
    name: torrent.name,
    status: torrent.status,
    done: torrent.percent_done,
    rateUpload: torrent.rate_upload,
    uploadedEver: torrent.uploaded_ever,
    downloadedEver: torrent.downloaded_ever,
    ratio: torrent.upload_ratio,
    secondsSeeding: torrent.seconds_seeding,
    peersConnected: torrent.peers_connected,
    peersGettingFromUs: torrent.peers_getting_from_us,
    peersSendingToUs: torrent.peers_sending_to_us,
    isPrivate: torrent.is_private,
    uploadLimited: torrent.upload_limited,
    uploadLimitKbps: torrent.upload_limit,
    seedRatioMode: torrent.seed_ratio_mode,
    seedRatioLimit: torrent.seed_ratio_limit,
    seedIdleMode: torrent.seed_idle_mode,
    seedIdleLimit: torrent.seed_idle_limit,
    trackers: (torrent.tracker_stats || []).map((tracker) => ({
      host: trackerHost(tracker.announce),
      tier: tracker.tier,
      announceState: tracker.announce_state,
      lastAnnounceSucceeded: tracker.last_announce_succeeded,
      lastAnnounceTimedOut: tracker.last_announce_timed_out,
      lastAnnounceResult: cleanTrackerResult(tracker.last_announce_result),
      lastAnnounceTime: tracker.last_announce_time,
      nextAnnounceTime: tracker.next_announce_time,
      seeders: tracker.seeder_count,
      leechers: tracker.leecher_count,
      downloads: tracker.download_count,
      hasAnnounced: tracker.has_announced,
    })),
  })),
  session: {
    peerPort: session.peer_port,
    portForwardingEnabled: session.port_forwarding_enabled,
    encryption: session.encryption,
    dhtEnabled: session.dht_enabled,
    pexEnabled: session.pex_enabled,
    utpEnabled: session.utp_enabled,
    uploadSpeedKbps: session.upload_speed,
    uploadSpeedEnabled: session.upload_speed_enabled,
    seedRatioLimit: session.seed_ratio_limit,
    seedRatioLimited: session.seed_ratio_limited,
    idleSeedingLimit: session.idle_seeding_limit,
    idleSeedingLimitEnabled: session.idle_seeding_limit_enabled,
  },
  stats,
  port,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
