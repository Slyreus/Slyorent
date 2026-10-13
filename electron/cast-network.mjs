import { createHash } from "node:crypto";
import dgram from "node:dgram";
import http from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

export const castError = (message, code = "CAST_FAILED") => Object.assign(new Error(message), { code });
export const safeText = (value, limit = 160) => String(value || "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, limit);
export const normalizedAddress = (value) => String(value || "").replace(/^::ffff:/iu, "");
export const castDeviceId = (kind, address, network) => createHash("sha256").update(`${kind}:${network.id}:${address}`).digest("hex").slice(0, 32);
const ipv4Number = (address) => address.split(".").reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);

export function privateAddress(address) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function sameNetwork(address, network) {
  address = normalizedAddress(address);
  if (!privateAddress(address) || !privateAddress(network?.address) || isIP(network?.netmask) !== 4) return false;
  const mask = ipv4Number(network.netmask), inverse = (~mask) >>> 0;
  if (mask === 0 || inverse === 0 || ((inverse + 1) & inverse) !== 0) return false;
  const ip = ipv4Number(address), base = (ipv4Number(network.address) & mask) >>> 0;
  return ((ip & mask) >>> 0) === base && ip !== base && ip !== ((base | inverse) >>> 0);
}

export function castNetworks() {
  const result = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (/loopback|vpn|nord|wireguard|openvpn|tailscale|zerotier|vethernet|docker|wsl/iu.test(name)) continue;
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== "IPv4" || !privateAddress(entry.address) || !sameNetwork(entry.address, entry)) continue;
      result.push({ id: createHash("sha256").update(`${name}:${entry.address}`).digest("hex").slice(0, 24), name: safeText(name, 80), address: entry.address, netmask: entry.netmask });
    }
  }
  return result.slice(0, 8);
}

export function localDeviceUrl(value, address, network, base) {
  let url;
  try { url = new URL(value, base); } catch { throw castError("Adresse de l’appareil invalide."); }
  const port = Number(url.port || 80);
  if (url.protocol !== "http:" || url.hostname !== address || !sameNetwork(address, network) || address === network.address || url.username || url.password || url.hash || url.href.length > 2048 || port < 1 || port > 65535 || [22, 25, 53, 135, 139, 445, 3389, 5985, 5986].includes(port)) throw castError("Adresse de l’appareil refusée.", "CAST_NETWORK_REFUSED");
  return url;
}

export function localHttp(url, network, { method = "GET", headers = {}, body, limit = 256 * 1024, signal } = {}) {
  localDeviceUrl(url.href, url.hostname, network);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: Number(url.port || 80), localAddress: network.address, path: url.pathname + url.search, method, headers, agent: false, signal }, (response) => {
      let bytes = 0; const chunks = [];
      response.on("data", (chunk) => { bytes += chunk.length; if (bytes > limit) request.destroy(castError("Réponse de l’appareil trop volumineuse.")); else chunks.push(chunk); });
      response.on("error", () => reject(castError("Réponse de l’appareil interrompue.")));
      response.on("end", () => response.statusCode === 200 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(castError("Commande refusée par l’appareil.")));
    });
    request.setTimeout(5000, () => request.destroy(castError("L’appareil ne répond pas.")));
    request.on("error", () => reject(castError("L’appareil ne répond pas.", "CAST_DEVICE_UNREACHABLE")));
    request.end(body);
  });
}

export const xmlEscape = (value) => String(value).replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
export function xmlText(xml, tag) {
  if (typeof xml !== "string" || xml.length > 256 * 1024 || /<!DOCTYPE|<!ENTITY/iu.test(xml) || !/^[A-Za-z][A-Za-z0-9]*$/u.test(tag)) throw castError("Description de l’appareil invalide.");
  const match = new RegExp(`<(?:(?:[\\w.-]+):)?${tag}(?:\\s[^>]{0,1024})?>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${tag}\\s*>`, "iu").exec(xml);
  return (match?.[1] || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1").replace(/<[^>]*>/gu, "").replace(/&(amp|lt|gt|quot|apos);/gu, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity]);
}

export function rendererDescription(xml, location, network) {
  xmlText(xml, "friendlyName");
  const services = [...xml.matchAll(/<(?:[\w.-]+:)?service(?:\s[^>]{0,1024})?>([\s\S]*?)<\/(?:[\w.-]+:)?service\s*>/giu)].slice(0, 48);
  const base = xmlText(xml, "URLBase") || location.href;
  localDeviceUrl(base, location.hostname, network);
  const service = (kind) => {
    for (const [, fragment] of services) {
      const type = xmlText(fragment, "serviceType");
      if (new RegExp(`^urn:schemas-upnp-org:service:${kind}:[123]$`, "u").test(type)) return { type, url: localDeviceUrl(xmlText(fragment, "controlURL"), location.hostname, network, base) };
    }
    return null;
  };
  const transport = service("AVTransport");
  if (!transport) return null;
  return { name: safeText(xmlText(xml, "friendlyName")) || "Téléviseur DLNA", model: safeText(xmlText(xml, "modelName"), 100), transport, rendering: service("RenderingControl") };
}

export function dnsRecords(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 12 || packet.length > 9000) return [];
  const readName = (start) => {
    let offset = start, end, hops = 0; const labels = [], visited = new Set();
    while (true) {
      if (++hops > 64 || offset >= packet.length || visited.has(offset)) throw new Error("DNS");
      visited.add(offset);
      const length = packet[offset++];
      if (length === 0) return { name: labels.join(".").toLowerCase(), end: end ?? offset };
      if ((length & 192) === 192) { if (offset >= packet.length) throw new Error("DNS"); end ??= offset + 1; offset = ((length & 63) << 8) | packet[offset]; continue; }
      if (length > 63 || offset + length > packet.length) throw new Error("DNS");
      labels.push(packet.subarray(offset, offset + length).toString("utf8")); offset += length;
      if (labels.join(".").length > 255) throw new Error("DNS");
    }
  };
  try {
    const questions = packet.readUInt16BE(4), count = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
    if (questions > 16 || count > 128) return [];
    let offset = 12; const records = [];
    for (let i = 0; i < questions; i++) offset = readName(offset).end + 4;
    for (let i = 0; i < count; i++) {
      const name = readName(offset); offset = name.end;
      if (offset + 10 > packet.length) return [];
      const type = packet.readUInt16BE(offset), length = packet.readUInt16BE(offset + 8), data = offset + 10;
      offset = data + length; if (offset > packet.length) return [];
      const record = { name: name.name, type };
      if (type === 1 && length === 4) record.address = [...packet.subarray(data, offset)].join(".");
      if (type === 33 && length > 6) { record.port = packet.readUInt16BE(data + 4); record.target = readName(data + 6).name; }
      if (type === 16) { record.txt = {}; let cursor = data; while (cursor < offset) { const size = packet[cursor++]; if (cursor + size > offset) return []; const [key, ...value] = packet.subarray(cursor, cursor + size).toString("utf8").split("="); record.txt[key] = value.join("="); cursor += size; } }
      records.push(record);
    }
    return records;
  } catch { return []; }
}

const castQuestion = () => {
  const labels = "_googlecast._tcp.local".split(".").flatMap((label) => [Buffer.from([label.length]), Buffer.from(label)]);
  const header = Buffer.alloc(12); header.writeUInt16BE(1, 4);
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 12, 128, 1])]);
};

/** Découverte ponctuelle sur les interfaces privées, sans écoute au démarrage. */
export async function discoverCastDevices(networks = castNetworks(), signal) {
  const devices = new Map(), descriptions = [];
  await Promise.all(networks.map((network) => new Promise((resolve) => {
    const socket = dgram.createSocket("udp4"); let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", finish); try { socket.close(); } catch { /* Déjà fermé. */ } resolve(); };
    const timer = setTimeout(finish, 4000); signal?.addEventListener("abort", finish, { once: true });
    socket.on("error", finish);
    socket.on("message", (message, remote) => {
      if (settled || signal?.aborted || devices.size + descriptions.length >= 64 || !sameNetwork(remote.address, network) || remote.address === network.address) return;
      if (message.length <= 8192 && message.subarray(0, 12).toString("ascii").startsWith("HTTP/1.1 200")) {
        const text = message.toString("utf8"), locations = [...text.matchAll(/^location:\s*(.+)$/gimu)];
        if (locations.length !== 1 || !/MediaRenderer|AVTransport/iu.test(text)) return;
        let url; try { url = localDeviceUrl(locations[0][1].trim(), remote.address, network); } catch { return; }
        const key = `dlna:${remote.address}`;
        if (devices.has(key)) return;
        devices.set(key, null);
        descriptions.push(localHttp(url, network, { signal }).then((xml) => { const device = rendererDescription(xml, url, network); if (device) devices.set(key, { ...device, id: castDeviceId("dlna", remote.address, network), kind: "dlna", address: remote.address, network, seenAt: Date.now() }); }).catch(() => undefined));
      } else {
        const records = dnsRecords(message);
        for (const record of records) {
          if (record.type !== 33 || record.port !== 8009 || !record.name.endsWith("._googlecast._tcp.local") || !records.some((item) => item.type === 1 && item.name === record.target && item.address === remote.address)) continue;
          const txt = records.find((item) => item.type === 16 && item.name === record.name)?.txt || {};
          devices.set(`cast:${remote.address}`, { id: castDeviceId("chromecast", remote.address, network), kind: "chromecast", address: remote.address, network, name: safeText(txt.fn) || "Google Cast", model: safeText(txt.md, 100), seenAt: Date.now() });
        }
      }
    });
    socket.bind(0, network.address, () => {
      if (settled || signal?.aborted) { finish(); return; }
      try {
        socket.setMulticastInterface(network.address); socket.setMulticastTTL(1);
        socket.send(castQuestion(), 5353, "224.0.0.251", () => undefined);
        socket.send(Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n'), 1900, "239.255.255.250", () => undefined);
      } catch { finish(); }
    });
    if (signal?.aborted) finish();
  })));
  await Promise.all(descriptions);
  return [...devices.values()].filter(Boolean).slice(0, 64);
}
