import { createHmac, randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

export const MAX_PEERS_PER_TORRENT = 128;
export const MAX_PEERS_TOTAL = 512;
export const MAX_TORRENTS_WITH_PEERS = 256;
export const MAX_PEER_RECORDS_SCANNED_PER_TORRENT = 512;

const MAX_ADDRESS_LENGTH = 64;
const MAX_TORRENT_NAME_LENGTH = 160;
const MAX_CITY_LENGTH = 96;
const MAX_COUNTRY_LENGTH = 96;
const MAX_RATE_BYTES_PER_SECOND = 1_000_000_000_000;
const PEER_ID_EPOCH_MS = 15 * 60_000;
const MIN_GEOIP_DATABASE_BYTES = 1 * 1024 * 1024;
const MAX_GEOIP_DATABASE_BYTES = 256 * 1024 * 1024;

function safeText(value, maximumLength) {
  if (typeof value !== "string" || value.length > maximumLength * 4) return "";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim()
    .slice(0, maximumLength);
}

function parseIpv4(address) {
  if (typeof address !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(address)) return null;
  const octets = address.split(".").map(Number);
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

function ipv4IsGlobal(address) {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseIpv6Words(address) {
  if (typeof address !== "string" || address.length > MAX_ADDRESS_LENGTH || address.includes("%")) return null;
  let expandedAddress = address.toLowerCase();
  if (expandedAddress.includes(".")) {
    const separator = expandedAddress.lastIndexOf(":");
    const ipv4 = parseIpv4(expandedAddress.slice(separator + 1));
    if (separator < 0 || !ipv4) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    expandedAddress = `${expandedAddress.slice(0, separator)}:${high}:${low}`;
  }
  const halves = expandedAddress.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((word) => Number.parseInt(word, 16));
  return words.length === 8 ? words : null;
}

function ipv6IsGlobal(address) {
  const words = parseIpv6Words(address);
  if (!words) return false;
  // IPv4-mapped IPv6 is deliberately rejected instead of being normalized.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) return false;
  // Only IPv6 global unicast (2000::/3), minus IANA documentation/transition ranges.
  if ((words[0] & 0xe000) !== 0x2000) return false;
  if (words[0] === 0x2001 && words[1] === 0x0000) return false; // Teredo
  if (words[0] === 0x2001 && words[1] === 0x0002) return false; // benchmarking
  if (words[0] === 0x2001 && words[1] >= 0x0010 && words[1] <= 0x001f) return false; // ORCHID
  if (words[0] === 0x2001 && words[1] >= 0x0020 && words[1] <= 0x002f) return false; // ORCHIDv2
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false; // documentation
  if (words[0] === 0x2002) return false; // deprecated 6to4 transition
  if (words[0] === 0x3fff && words[1] <= 0x0fff) return false; // documentation
  return true;
}

export function isGlobalUnicastAddress(address) {
  if (typeof address !== "string" || address.length === 0 || address.length > MAX_ADDRESS_LENGTH || /\s/u.test(address)) return false;
  const version = isIP(address);
  if (version === 4) return ipv4IsGlobal(address);
  if (version === 6) return ipv6IsGlobal(address);
  return false;
}

function validRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_RATE_BYTES_PER_SECOND
    ? Math.trunc(value)
    : null;
}

function validProgress(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1.000_001
    ? Math.min(1, value)
    : null;
}

function countryName(countryCode) {
  if (!countryCode) return null;
  try {
    return safeText(new Intl.DisplayNames(["fr"], { type: "region" }).of(countryCode), MAX_COUNTRY_LENGTH) || countryCode;
  } catch {
    return countryCode;
  }
}

function safeGeoResult(raw, address) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const countryCode = typeof raw.country === "string" && /^[A-Za-z]{2}$/u.test(raw.country) ? raw.country.toUpperCase() : null;
  const candidateCity = safeText(raw.city, MAX_CITY_LENGTH);
  const cityContainsAddress = candidateCity.toLowerCase().includes(address.toLowerCase())
    || /\d{1,3}(?:\.\d{1,3}){3}/u.test(candidateCity)
    || /[0-9a-f]{0,4}:[0-9a-f:]{2,}/iu.test(candidateCity);
  const city = candidateCity && !cityContainsAddress ? candidateCity : null;
  const coordinates = Array.isArray(raw.ll) && raw.ll.length === 2 ? raw.ll : [raw.latitude, raw.longitude];
  const latitude = typeof coordinates[0] === "number" && Number.isFinite(coordinates[0]) && coordinates[0] >= -90 && coordinates[0] <= 90 ? coordinates[0] : null;
  const longitude = typeof coordinates[1] === "number" && Number.isFinite(coordinates[1]) && coordinates[1] >= -180 && coordinates[1] <= 180 ? coordinates[1] : null;
  const resolved = latitude !== null && longitude !== null;
  return {
    countryCode,
    country: countryName(countryCode),
    city,
    latitude: resolved ? latitude : null,
    longitude: resolved ? longitude : null,
    locationStatus: resolved ? "resolved" : "unavailable",
  };
}

function unavailableLocation() {
  return { countryCode: null, country: null, city: null, latitude: null, longitude: null, locationStatus: "unavailable" };
}

export function approximateLocalLocation(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const normalizedTimeZone = safeText(timeZone, 64) || "Europe/Paris";
  // A timezone is metadata, never a sufficiently precise position for the map.
  return Object.freeze({
    status: "unavailable",
    source: "none",
    approximate: true,
    local: true,
    timeZone: normalizedTimeZone,
    latitude: null,
    longitude: null,
    reason: "explicit-location-required",
    manualPlacementAllowed: true,
    persisted: false,
  });
}

export class PeerTelemetry {
  #lookup;
  #providerName;
  #secret;
  #clock;
  #localLocation;

  constructor({ lookup = null, providerName = "unavailable", secret = randomBytes(32), clock = () => Date.now(), timeZone } = {}) {
    if (lookup !== null && typeof lookup !== "function") throw new TypeError("Le résolveur GeoIP doit être une fonction locale.");
    if (!(secret instanceof Uint8Array) || secret.byteLength < 32) throw new TypeError("Le secret éphémère doit contenir au moins 32 octets.");
    this.#lookup = lookup;
    this.#providerName = lookup ? safeText(providerName, 32) || "offline" : "unavailable";
    this.#secret = Buffer.from(secret);
    this.#clock = clock;
    this.#localLocation = approximateLocalLocation(timeZone);
  }

  get provider() {
    return Object.freeze({ offline: true, available: Boolean(this.#lookup), name: this.#providerName });
  }

  #ephemeralId(torrentId, address, port, now) {
    const epoch = Math.floor(now / PEER_ID_EPOCH_MS);
    return createHmac("sha256", this.#secret)
      .update(String(epoch))
      .update("\0")
      .update(String(torrentId))
      .update("\0")
      .update(address)
      .update("\0")
      .update(String(port))
      .digest("base64url")
      .slice(0, 16);
  }

  #location(address) {
    if (!this.#lookup) return unavailableLocation();
    try {
      return safeGeoResult(this.#lookup(address), address) || unavailableLocation();
    } catch {
      return unavailableLocation();
    }
  }

  #peer(peer, torrentId, now) {
    if (!peer || typeof peer !== "object" || Array.isArray(peer)) return null;
    const address = peer.address;
    if (!isGlobalUnicastAddress(address)) return null;
    const port = Number.isInteger(peer.port) && peer.port >= 0 && peer.port <= 65_535 ? peer.port : 0;
    const rateDownload = validRate(peer.rate_to_client);
    const rateUpload = validRate(peer.rate_to_peer);
    const progress = validProgress(peer.progress);
    if (rateDownload === null || rateUpload === null || progress === null) return null;
    const id = this.#ephemeralId(torrentId, address, port, now);
    const active = rateDownload > 0 || rateUpload > 0;
    const direction = !active ? "inactive" : rateDownload > 0 && rateUpload > 0 ? "bidirectional" : rateDownload > 0 ? "download" : "upload";
    return {
      id,
      label: `Pair ${id.slice(0, 6)}`,
      ...this.#location(address),
      rateDownload,
      rateUpload,
      progress,
      active,
      encrypted: peer.is_encrypted === true,
      connection: peer.is_incoming === true ? "incoming" : "outgoing",
      direction,
    };
  }

  normalizeTorrents(torrents) {
    const source = Array.isArray(torrents) ? torrents : [];
    const now = this.#clock();
    if (!Number.isFinite(now) || now < 0) throw new Error("Horloge de télémétrie invalide.");
    const flatPeers = [];
    const peersByTorrentId = new Map();
    let observed = 0;
    let active = 0;
    let filtered = 0;
    let truncated = source.length > MAX_TORRENTS_WITH_PEERS;

    for (const torrent of source.slice(0, MAX_TORRENTS_WITH_PEERS)) {
      const torrentId = Number(torrent?.id);
      if (!Number.isInteger(torrentId) || torrentId < 0 || torrentId > 2_147_483_647) continue;
      const torrentName = safeText(torrent?.name, MAX_TORRENT_NAME_LENGTH) || "Torrent sans nom";
      const rawPeers = Array.isArray(torrent?.peers) ? torrent.peers : [];
      observed = Math.min(Number.MAX_SAFE_INTEGER, observed + rawPeers.length);
      if (rawPeers.length > MAX_PEER_RECORDS_SCANNED_PER_TORRENT) truncated = true;
      const nested = [];
      for (const rawPeer of rawPeers.slice(0, MAX_PEER_RECORDS_SCANNED_PER_TORRENT)) {
        const peer = this.#peer(rawPeer, torrentId, now);
        if (!peer) {
          filtered += 1;
          continue;
        }
        if (peer.active) active += 1;
        if (nested.length >= MAX_PEERS_PER_TORRENT || flatPeers.length >= MAX_PEERS_TOTAL) {
          truncated = true;
          continue;
        }
        nested.push(peer);
        flatPeers.push({ torrentId, torrentName, ...peer });
      }
      peersByTorrentId.set(torrentId, Object.freeze(nested));
    }

    return {
      flatPeers: Object.freeze(flatPeers),
      peersByTorrentId,
      counts: Object.freeze({ observed, active, returned: flatPeers.length, filtered }),
      truncated,
      capturedAt: new Date(now).toISOString(),
    };
  }

  snapshot(torrents) {
    const normalized = this.normalizeTorrents(torrents);
    return Object.freeze({
      capturedAt: normalized.capturedAt,
      localLocation: this.#localLocation,
      geoProvider: this.provider,
      peers: normalized.flatPeers,
      counts: normalized.counts,
      truncated: normalized.truncated,
    });
  }
}

export async function createDefaultPeerTelemetry({ databasePath, ...options } = {}) {
  try {
    if (typeof databasePath === "string" && databasePath.length > 0 && databasePath.length <= 1_024 && path.extname(databasePath).toLowerCase() === ".mmdb") {
      const databaseInfo = await lstat(databasePath);
      if (databaseInfo.isFile() && !databaseInfo.isSymbolicLink() && databaseInfo.size >= MIN_GEOIP_DATABASE_BYTES && databaseInfo.size <= MAX_GEOIP_DATABASE_BYTES) {
        const canonicalDatabase = await realpath(databasePath);
        if (path.resolve(canonicalDatabase).toLowerCase() === path.resolve(databasePath).toLowerCase()) {
          const imported = await import("@maxmind/geoip2-node");
          if (typeof imported.Reader?.open === "function") {
            const reader = await imported.Reader.open(canonicalDatabase);
            return new PeerTelemetry({
              ...options,
              providerName: "maxmind-geolite2-city",
              lookup(address) {
                const response = reader.city(address);
                return {
                  country: response?.country?.isoCode,
                  city: response?.city?.names?.fr || response?.city?.names?.en,
                  ll: [response?.location?.latitude, response?.location?.longitude],
                };
              },
            });
          }
        }
      }
    }
  } catch {
    // La base locale optionnelle n'est pas exploitable : essayer la base embarquée ci-dessous.
  }

  try {
    const imported = await import("geoip-lite");
    const geoip = imported.default || imported;
    if (typeof geoip.lookup === "function") {
      return new PeerTelemetry({
        ...options,
        providerName: "geoip-lite-offline",
        lookup: (address) => geoip.lookup(address),
      });
    }
  } catch {
    // Aucun appel réseau de repli : une position inconnue reste inconnue.
  }
  return new PeerTelemetry(options);
}
