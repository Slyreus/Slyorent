import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const MAX_SAMPLES = 4_320;
const MAX_TORRENTS_PER_SAMPLE = 256;
const MAX_WINDOW_HOURS = 72;
const MIN_SAMPLE_INTERVAL_MS = 45_000;
const MAX_COUNT = 1_000_000;
const MAX_BYTES = Number.MAX_SAFE_INTEGER;

function finiteNumber(value, minimum = 0, maximum = MAX_BYTES) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : minimum;
}

function finiteInteger(value, minimum = 0, maximum = MAX_BYTES) {
  return Math.trunc(finiteNumber(value, minimum, maximum));
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizeTorrentSample(torrent) {
  const rawId = Number(torrent?.id);
  if (!Number.isInteger(rawId) || rawId < 0 || rawId > 2_147_483_647) return null;
  return {
    id: rawId,
    uploadedBytes: finiteInteger(torrent?.uploadedBytes),
    uploadRate: finiteInteger(torrent?.uploadRate),
    connectedPeers: finiteInteger(torrent?.connectedPeers, 0, MAX_COUNT),
    servedPeers: finiteInteger(torrent?.servedPeers, 0, MAX_COUNT),
  };
}

function normalizeSample(sample) {
  if (!validTimestamp(sample?.ts) || !Array.isArray(sample?.torrents) || sample.torrents.length > MAX_TORRENTS_PER_SAMPLE) return null;
  const torrents = sample.torrents.map(normalizeTorrentSample);
  if (torrents.some((torrent) => torrent === null)) return null;
  return {
    ts: new Date(sample.ts).toISOString(),
    totalUploadedBytes: finiteInteger(sample.totalUploadedBytes),
    uploadRate: finiteInteger(sample.uploadRate),
    activeTorrents: finiteInteger(sample.activeTorrents, 0, MAX_COUNT),
    completedTorrents: finiteInteger(sample.completedTorrents, 0, MAX_COUNT),
    connectedPeers: finiteInteger(sample.connectedPeers, 0, MAX_COUNT),
    servedPeers: finiteInteger(sample.servedPeers, 0, MAX_COUNT),
    incompletePeers: finiteInteger(sample.incompletePeers, 0, MAX_COUNT),
    interestedPeers: finiteInteger(sample.interestedPeers, 0, MAX_COUNT),
    unchokedInterestedPeers: finiteInteger(sample.unchokedInterestedPeers, 0, MAX_COUNT),
    incomingPeers: finiteInteger(sample.incomingPeers, 0, MAX_COUNT),
    utpPeers: finiteInteger(sample.utpPeers, 0, MAX_COUNT),
    tcpPeers: finiteInteger(sample.tcpPeers, 0, MAX_COUNT),
    encryptedPeers: finiteInteger(sample.encryptedPeers, 0, MAX_COUNT),
    trackerLeechers: finiteInteger(sample.trackerLeechers, 0, MAX_COUNT),
    trackerPeerCandidates: finiteInteger(sample.trackerPeerCandidates, 0, MAX_COUNT),
    torrents,
  };
}

function summarizePeers(peers) {
  const summary = {
    connected: 0, incomplete: 0, interested: 0, unchokedInterested: 0,
    incoming: 0, utp: 0, tcp: 0, encrypted: 0,
  };
  for (const peer of Array.isArray(peers) ? peers.slice(0, 512) : []) {
    summary.connected += 1;
    if (Number(peer?.progress || 0) < 0.999999) summary.incomplete += 1;
    if (peer?.peer_is_interested === true) {
      summary.interested += 1;
      if (peer?.peer_is_choked === false) summary.unchokedInterested += 1;
    }
    if (peer?.is_incoming === true) summary.incoming += 1;
    if (peer?.is_utp === true) summary.utp += 1;
    else if (peer?.is_utp === false) summary.tcp += 1;
    if (peer?.is_encrypted === true) summary.encrypted += 1;
  }
  return summary;
}

function trackerLeechers(torrent) {
  return (Array.isArray(torrent?.tracker_stats) ? torrent.tracker_stats : []).reduce(
    (maximum, tracker) => Math.max(maximum, finiteInteger(tracker?.leecher_count, 0, MAX_COUNT)),
    0,
  );
}

function trackerPeerCandidates(torrent) {
  return (Array.isArray(torrent?.tracker_stats) ? torrent.tracker_stats : []).reduce(
    (maximum, tracker) => Math.max(maximum, finiteInteger(tracker?.last_announce_peer_count, 0, MAX_COUNT)),
    0,
  );
}

async function atomicPrivateWrite(filePath, contents) {
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, filePath);
}

export class SharingHistory {
  #filePath;
  #manager;
  #audit;
  #clock;
  #samples = [];
  #operationQueue = Promise.resolve();

  constructor({ filePath, manager, audit, clock = () => new Date() }) {
    this.#filePath = path.resolve(filePath);
    this.#manager = manager;
    this.#audit = audit;
    this.#clock = clock;
  }

  async initialize() {
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(await readFile(this.#filePath, "utf8"));
      if (stored?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(stored.samples) || stored.samples.length > MAX_SAMPLES) {
        throw new Error("FORMAT_INVALID");
      }
      const samples = stored.samples.map(normalizeSample);
      if (samples.some((sample) => sample === null)) throw new Error("FORMAT_INVALID");
      this.#samples = samples.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.#samples = [];
        await this.#audit?.append("sharing.history_reset", { reason: "FORMAT_INVALID" }).catch(() => undefined);
      }
    }
    return this;
  }

  #serialize(operation) {
    const run = this.#operationQueue.then(operation, operation);
    this.#operationQueue = run.catch(() => undefined);
    return run;
  }

  record() {
    return this.#serialize(async () => {
      const now = this.#clock();
      const timestamp = now instanceof Date ? now : new Date(now);
      if (!Number.isFinite(timestamp.getTime())) throw new Error("Horodatage de suivi invalide.");
      const previous = this.#samples.at(-1);
      if (previous && timestamp.getTime() - Date.parse(previous.ts) < MIN_SAMPLE_INTERVAL_MS) return previous;

      const fields = [
        "id", "status", "percent_done", "uploaded_ever", "rate_upload", "peers_connected",
        "peers_getting_from_us", "tracker_stats", "peers",
      ];
      const [{ torrents = [] }, sessionStats] = await Promise.all([
        this.#manager.rpc.call("torrent_get", { fields }),
        this.#manager.rpc.call("session_stats").catch(() => ({})),
      ]);
      const normalizedTorrents = (Array.isArray(torrents) ? torrents : []).slice(0, MAX_TORRENTS_PER_SAMPLE);
      let incompletePeers = 0;
      let interestedPeers = 0;
      let unchokedInterestedPeers = 0;
      let incomingPeers = 0;
      let utpPeers = 0;
      let tcpPeers = 0;
      let encryptedPeers = 0;
      let connectedPeers = 0;
      let servedPeers = 0;
      let totalTrackerLeechers = 0;
      let totalTrackerPeerCandidates = 0;
      const compactTorrents = [];

      for (const torrent of normalizedTorrents) {
        const peerFlow = summarizePeers(torrent.peers);
        const torrentConnectedPeers = finiteInteger(torrent.peers_connected, 0, MAX_COUNT);
        const torrentServedPeers = finiteInteger(torrent.peers_getting_from_us, 0, MAX_COUNT);
        connectedPeers += torrentConnectedPeers;
        servedPeers += torrentServedPeers;
        incompletePeers += peerFlow.incomplete;
        interestedPeers += peerFlow.interested;
        unchokedInterestedPeers += peerFlow.unchokedInterested;
        incomingPeers += peerFlow.incoming;
        utpPeers += peerFlow.utp;
        tcpPeers += peerFlow.tcp;
        encryptedPeers += peerFlow.encrypted;
        totalTrackerLeechers += trackerLeechers(torrent);
        totalTrackerPeerCandidates += trackerPeerCandidates(torrent);
        compactTorrents.push({
          id: finiteInteger(torrent.id, 0, 2_147_483_647),
          uploadedBytes: finiteInteger(torrent.uploaded_ever),
          uploadRate: finiteInteger(torrent.rate_upload),
          connectedPeers: torrentConnectedPeers,
          servedPeers: torrentServedPeers,
        });
      }

      const fallbackUploaded = compactTorrents.reduce((total, torrent) => total + torrent.uploadedBytes, 0);
      const fallbackRate = compactTorrents.reduce((total, torrent) => total + torrent.uploadRate, 0);
      const sample = normalizeSample({
        ts: timestamp.toISOString(),
        totalUploadedBytes: sessionStats?.cumulative_stats?.uploaded_bytes ?? fallbackUploaded,
        uploadRate: sessionStats?.upload_speed ?? fallbackRate,
        activeTorrents: sessionStats?.active_torrent_count ?? 0,
        completedTorrents: normalizedTorrents.filter((torrent) => Number(torrent.percent_done || 0) >= 0.999999).length,
        connectedPeers,
        servedPeers,
        incompletePeers,
        interestedPeers,
        unchokedInterestedPeers,
        incomingPeers,
        utpPeers,
        tcpPeers,
        encryptedPeers,
        trackerLeechers: totalTrackerLeechers,
        trackerPeerCandidates: totalTrackerPeerCandidates,
        torrents: compactTorrents,
      });
      if (!sample) throw new Error("Échantillon de partage invalide.");
      this.#samples.push(sample);
      if (this.#samples.length > MAX_SAMPLES) this.#samples.splice(0, this.#samples.length - MAX_SAMPLES);
      await atomicPrivateWrite(this.#filePath, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, samples: this.#samples })}\n`);
      return sample;
    });
  }

  async summary(hours = 12) {
    await this.#operationQueue;
    const requestedHours = Number(hours);
    const safeHours = Math.min(MAX_WINDOW_HOURS, Math.max(1, Number.isFinite(requestedHours) ? requestedHours : 12));
    const now = this.#clock();
    const endMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const cutoff = endMs - safeHours * 3_600_000;
    const samples = this.#samples.filter((sample) => Date.parse(sample.ts) >= cutoff && Date.parse(sample.ts) <= endMs);
    if (samples.length === 0) {
      return {
        schemaVersion: SCHEMA_VERSION, windowHours: safeHours, from: null, to: null, sampleCount: 0, observedSeconds: 0,
        uploadedBytes: 0, peakUploadRate: 0, uploadActiveSeconds: 0, connectedSeconds: 0, peerDemandSeconds: 0,
        trackerDemandSeconds: 0, maxConnectedPeers: 0, maxInterestedPeers: 0, maxServedPeers: 0, byTorrent: [],
        maxIncomingPeers: 0, maxUtpPeers: 0, maxTcpPeers: 0, maxEncryptedPeers: 0, maxTrackerPeerCandidates: 0,
      };
    }

    let uploadedBytes = 0;
    let observedSeconds = 0;
    let uploadActiveSeconds = 0;
    let connectedSeconds = 0;
    let peerDemandSeconds = 0;
    let trackerDemandSeconds = 0;
    const byTorrent = new Map();
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      const intervalSeconds = Math.min(300, Math.max(0, (Date.parse(current.ts) - Date.parse(previous.ts)) / 1_000));
      observedSeconds += intervalSeconds;
      uploadedBytes += Math.max(0, current.totalUploadedBytes - previous.totalUploadedBytes);
      if (current.uploadRate > 0 || current.servedPeers > 0) uploadActiveSeconds += intervalSeconds;
      if (current.connectedPeers > 0) connectedSeconds += intervalSeconds;
      if (current.incompletePeers > 0 || current.interestedPeers > 0) peerDemandSeconds += intervalSeconds;
      if (current.trackerLeechers > 0) trackerDemandSeconds += intervalSeconds;

      const previousById = new Map(previous.torrents.map((torrent) => [torrent.id, torrent]));
      for (const torrent of current.torrents) {
        const before = previousById.get(torrent.id);
        if (!before) continue;
        const delta = Math.max(0, torrent.uploadedBytes - before.uploadedBytes);
        if (delta > 0) byTorrent.set(torrent.id, (byTorrent.get(torrent.id) || 0) + delta);
      }
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      windowHours: safeHours,
      from: samples[0].ts,
      to: samples.at(-1).ts,
      sampleCount: samples.length,
      observedSeconds: Math.round(observedSeconds),
      uploadedBytes: Math.round(uploadedBytes),
      peakUploadRate: Math.max(...samples.map((sample) => sample.uploadRate)),
      uploadActiveSeconds: Math.round(uploadActiveSeconds),
      connectedSeconds: Math.round(connectedSeconds),
      peerDemandSeconds: Math.round(peerDemandSeconds),
      trackerDemandSeconds: Math.round(trackerDemandSeconds),
      maxConnectedPeers: Math.max(...samples.map((sample) => sample.connectedPeers)),
      maxInterestedPeers: Math.max(...samples.map((sample) => sample.interestedPeers)),
      maxServedPeers: Math.max(...samples.map((sample) => sample.servedPeers)),
      maxIncomingPeers: Math.max(...samples.map((sample) => sample.incomingPeers)),
      maxUtpPeers: Math.max(...samples.map((sample) => sample.utpPeers)),
      maxTcpPeers: Math.max(...samples.map((sample) => sample.tcpPeers)),
      maxEncryptedPeers: Math.max(...samples.map((sample) => sample.encryptedPeers)),
      maxTrackerPeerCandidates: Math.max(...samples.map((sample) => sample.trackerPeerCandidates)),
      byTorrent: [...byTorrent.entries()]
        .map(([id, bytes]) => ({ id, uploadedBytes: Math.round(bytes) }))
        .sort((left, right) => right.uploadedBytes - left.uploadedBytes)
        .slice(0, MAX_TORRENTS_PER_SAMPLE),
    };
  }
}
