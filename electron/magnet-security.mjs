import dns from "node:dns/promises";
import net from "node:net";

const MAX_MAGNET_LENGTH = 4_096;
const MAX_PARAMETERS = 128;
const MAX_TRACKERS = 64;
const FORBIDDEN_PARAMETERS = new Set(["as", "ws", "xs", "x.pe"]);
const TRACKER_PROTOCOLS = new Set(["http:", "https:", "udp:"]);

function safeDisplayName(value) {
  return String(value || "Torrent sans nom")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\\/]/g, "_")
    .replace(/\.\.+/g, ".")
    .trim()
    .slice(0, 180) || "Torrent sans nom";
}

function validExactTopic(topic) {
  const lower = topic.toLowerCase();
  if (/^urn:btih:[a-f0-9]{40}$/.test(lower)) return { version: "v1", hash: lower.slice(9) };
  if (/^urn:btih:[a-z2-7]{32}$/.test(lower)) return { version: "v1-base32", hash: lower.slice(9) };
  if (/^urn:btmh:1220[a-f0-9]{64}$/.test(lower)) return { version: "v2", hash: lower.slice(9) };
  return null;
}

function normalizeHostname(hostname) {
  const value = String(hostname || "").trim().toLowerCase();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function ipv6Bytes(address) {
  let value = normalizeHostname(address).split("%")[0];
  if (!value || value.split("::").length > 2) return null;

  const dottedIndex = value.lastIndexOf(":");
  const dottedTail = dottedIndex >= 0 ? value.slice(dottedIndex + 1) : "";
  if (dottedTail.includes(".")) {
    if (!net.isIPv4(dottedTail)) return null;
    const octets = dottedTail.split(".").map(Number);
    value = `${value.slice(0, dottedIndex)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const [leftRaw, rightRaw = ""] = value.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/u.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((value.includes("::") && missing < 1) || (!value.includes("::") && missing !== 0)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((part) => Number.parseInt(part, 16));
  if (groups.length !== 8) return null;
  return Uint8Array.from(groups.flatMap((group) => [group >>> 8, group & 0xff]));
}

function isPrivateAddress(address) {
  const normalized = normalizeHostname(address).split("%")[0];
  if (net.isIPv4(normalized)) {
    const [a, b, c] = normalized.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (net.isIPv6(normalized)) {
    const bytes = ipv6Bytes(normalized);
    if (!bytes) return true;
    const firstTenZero = bytes.slice(0, 10).every((value) => value === 0);
    if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
      return isPrivateAddress(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
    }
    // IPv4-compatible, ULA, link/site-local, multicast ou non-global.
    if (bytes.slice(0, 12).every((value) => value === 0)) return true;
    if ((bytes[0] & 0xe0) !== 0x20) return true;
    // Préfixes spéciaux qui encapsulent une IPv4 ou ne sont pas routables.
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true; // Teredo
    if (bytes[0] === 0x20 && bytes[1] === 0x02) return true; // 6to4
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // documentation
    return false;
  }
  return true;
}

export function inspectMagnet(magnet) {
  const issues = [];
  const warnings = [];
  if (typeof magnet !== "string" || magnet.length === 0 || magnet.length > MAX_MAGNET_LENGTH) {
    return { valid: false, verdict: "blocked", score: 0, name: "Magnet invalide", hash: null, trackers: [], issues: ["Longueur du magnet invalide."], warnings };
  }

  let parsed;
  try {
    parsed = new URL(magnet);
  } catch {
    return { valid: false, verdict: "blocked", score: 0, name: "Magnet invalide", hash: null, trackers: [], issues: ["URI magnet illisible."], warnings };
  }
  if (parsed.protocol !== "magnet:") issues.push("Le protocole doit être magnet:.");

  const parameters = [...parsed.searchParams.entries()];
  if (parameters.length > MAX_PARAMETERS) issues.push("Trop de paramètres dans le magnet.");
  for (const [key] of parameters) {
    if (FORBIDDEN_PARAMETERS.has(key.toLowerCase())) issues.push(`Paramètre réseau interdit: ${key}.`);
  }

  const exactTopics = parsed.searchParams.getAll("xt").map(validExactTopic).filter(Boolean);
  if (exactTopics.length !== 1) issues.push("Le magnet doit contenir un unique infohash BitTorrent valide.");

  const trackers = parsed.searchParams.getAll("tr");
  if (trackers.length > MAX_TRACKERS) issues.push("Trop de trackers déclarés.");
  for (const tracker of trackers) {
    try {
      const trackerUrl = new URL(tracker);
      const hostname = normalizeHostname(trackerUrl.hostname);
      if (!TRACKER_PROTOCOLS.has(trackerUrl.protocol)) issues.push("Un tracker utilise un protocole non autorisé.");
      if (trackerUrl.username || trackerUrl.password) issues.push("Les identifiants intégrés dans un tracker sont interdits.");
      if (!hostname) issues.push("Un tracker ne possède pas d'hôte valide.");
      if (net.isIP(hostname) && isPrivateAddress(hostname)) issues.push("Un tracker pointe vers un réseau local ou réservé.");
    } catch {
      issues.push("Une URL de tracker est invalide.");
    }
  }

  if (trackers.length === 0) warnings.push("Aucun tracker: la découverte dépendra de DHT/PEX.");
  const topic = exactTopics[0] ?? null;
  return {
    valid: issues.length === 0,
    verdict: issues.length ? "blocked" : warnings.length ? "review" : "clean",
    score: issues.length ? 0 : warnings.length ? 72 : 92,
    name: safeDisplayName(parsed.searchParams.get("dn")),
    hash: topic?.hash ?? null,
    hashVersion: topic?.version ?? null,
    trackers: trackers.map((tracker) => {
      try { return normalizeHostname(new URL(tracker).hostname); } catch { return "invalide"; }
    }),
    issues: [...new Set(issues)],
    warnings,
  };
}

export async function assertSafeMagnetNetworkTargets(magnet) {
  const inspection = inspectMagnet(magnet);
  if (!inspection.valid) throw new Error(inspection.issues[0] || "Magnet refusé.");
  const parsed = new URL(magnet);
  const hostnames = new Set();
  for (const tracker of parsed.searchParams.getAll("tr")) {
    const trackerUrl = new URL(tracker);
    const hostname = normalizeHostname(trackerUrl.hostname);
    if (!net.isIP(hostname)) hostnames.add(hostname);
  }

  for (const hostname of hostnames) {
    let addresses;
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("Un tracker ne peut pas être résolu de façon sûre.");
    }
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error("Un tracker résout vers un réseau local ou réservé.");
    }
  }
  return inspection;
}

export async function assertSafeTrackerUrls(trackers) {
  if (!Array.isArray(trackers) || trackers.length > MAX_TRACKERS) throw new Error("Liste de trackers invalide.");
  const hostnames = new Set();
  for (const tracker of trackers) {
    let trackerUrl;
    try { trackerUrl = new URL(tracker); } catch { throw new Error("Une URL de tracker est invalide."); }
    const hostname = normalizeHostname(trackerUrl.hostname);
    if (!TRACKER_PROTOCOLS.has(trackerUrl.protocol) || !hostname || trackerUrl.username || trackerUrl.password) {
      throw new Error("Un tracker importé n'est pas autorisé.");
    }
    if (net.isIP(hostname)) {
      if (isPrivateAddress(hostname)) throw new Error("Un tracker pointe vers un réseau local ou réservé.");
    } else {
      hostnames.add(hostname);
    }
  }
  for (const hostname of hostnames) {
    let addresses;
    try { addresses = await dns.lookup(hostname, { all: true, verbatim: true }); } catch { throw new Error("Un tracker ne peut pas être résolu de façon sûre."); }
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error("Un tracker résout vers un réseau local ou réservé.");
    }
  }
}
