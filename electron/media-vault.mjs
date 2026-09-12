import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";

const TOKEN_TTL_MS = 15 * 60_000;
const MAX_RANGE_HEADER_LENGTH = 128;
const MAX_MEDIA_TOKENS = 256;

function tokenFromUrl(value) {
  const url = new URL(value);
  const token = url.pathname.slice(1);
  if (url.protocol !== "secutorrent-media:" || url.hostname !== "stream" || url.port || url.search || url.hash || url.username || url.password || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return token;
}

const MEDIA_TYPES = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
  [".flac", "audio/flac"],
]);

function extensionOf(filePath) {
  const dot = filePath.lastIndexOf(".");
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
}

function sniffMatches(extension, bytes) {
  const ascii = (start, end) => bytes.subarray(start, end).toString("ascii");
  if ([".mp4", ".m4v", ".m4a"].includes(extension)) return ascii(4, 8) === "ftyp";
  if ([".webm", ".mkv"].includes(extension)) return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if ([".ogg", ".oga", ".opus"].includes(extension)) return ascii(0, 4) === "OggS";
  if (extension === ".wav") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
  if (extension === ".flac") return ascii(0, 4) === "fLaC";
  if (extension === ".mp3") return ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (extension === ".aac") return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  return false;
}

function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  if (header.length > MAX_RANGE_HEADER_LENGTH || !header.startsWith("bytes=") || header.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return null;
  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1), partial: true };
}

export function isMediaName(name) {
  return MEDIA_TYPES.has(extensionOf(name));
}

export async function validateMediaSignature(filePath) {
  const extension = extensionOf(filePath);
  const mimeType = MEDIA_TYPES.get(extension);
  if (!mimeType) throw new Error("Ce format n'est pas autorisé par le lecteur sécurisé.");
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!sniffMatches(extension, buffer.subarray(0, bytesRead))) throw new Error("La signature du fichier ne correspond pas à son extension média.");
  } finally {
    await handle.close();
  }
  return mimeType;
}

export class MediaVault {
  #tokens = new Map();
  #now;

  constructor({ now = Date.now } = {}) { this.#now = now; }

  issue({ filePath, torrentKey, ownerWebContentsId, mimeType, name, expectedSize, expectedMtimeMs }) {
    this.prune();
    if (this.#tokens.size >= MAX_MEDIA_TOKENS) throw new Error("Trop d’accès média ouverts.");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + TOKEN_TTL_MS;
    this.#tokens.set(token, { filePath, torrentKey, ownerWebContentsId, mimeType, name, expectedSize, expectedMtimeMs, expiresAt, streams: new Set() });
    return { url: `secutorrent-media://stream/${token}`, expiresAt: new Date(expiresAt).toISOString(), mimeType, name };
  }

  revokeTorrent(torrentKey) {
    for (const [token, entry] of this.#tokens) if (entry.torrentKey === torrentKey) this.#revoke(token);
  }

  revokeOwner(ownerWebContentsId) {
    for (const [token, entry] of this.#tokens) if (entry.ownerWebContentsId === ownerWebContentsId) this.#revoke(token);
  }

  #revoke(token) {
    const entry = this.#tokens.get(token);
    this.#tokens.delete(token);
    for (const stream of entry?.streams || []) stream.destroy(new Error("Accès média révoqué."));
  }

  isFileInUse(filePath) {
    this.prune();
    return [...this.#tokens.values()].some((entry) => entry.filePath === filePath);
  }

  #ownedEntry(url, ownerWebContentsId) {
    this.prune();
    let token;
    try { token = tokenFromUrl(url); } catch { throw new Error("Accès média invalide."); }
    const entry = this.#tokens.get(token);
    if (!entry || entry.ownerWebContentsId !== ownerWebContentsId) throw new Error("Accès média expiré ou refusé.");
    return { token, entry };
  }

  async renew(url, ownerWebContentsId) {
    const { token, entry } = this.#ownedEntry(url, ownerWebContentsId);
    const handle = await open(entry.filePath, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== entry.expectedSize || info.mtimeMs !== entry.expectedMtimeMs) {
        this.#revoke(token);
        throw new Error("Le média a changé depuis sa validation.");
      }
      if (this.#tokens.get(token) !== entry) throw new Error("Accès média révoqué.");
      entry.expiresAt = this.#now() + TOKEN_TTL_MS;
      return { expiresAt: new Date(entry.expiresAt).toISOString() };
    } finally { await handle.close(); }
  }

  release(url, ownerWebContentsId) {
    try { this.#revoke(this.#ownedEntry(url, ownerWebContentsId).token); } catch { /* Un accès expiré est déjà révoqué. */ }
    return { ok: true };
  }

  prune() {
    const now = this.#now();
    for (const [token, entry] of this.#tokens) if (entry.expiresAt <= now) this.#revoke(token);
  }

  async handle(request) {
    let fileHandle;
    try {
      this.prune();
      const token = tokenFromUrl(request.url);
      const entry = this.#tokens.get(token);
      if (!entry) return new Response(null, { status: 404 });
      if (Number.isInteger(request.webContentsId) && request.webContentsId > 0 && request.webContentsId !== entry.ownerWebContentsId) return new Response(null, { status: 403 });
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
      if (request.signal?.aborted) return new Response(null, { status: 408 });

      fileHandle = await open(entry.filePath, "r");
      const file = await fileHandle.stat();
      if (this.#tokens.get(token) !== entry) return new Response(null, { status: 404 });
      if (request.signal?.aborted) return new Response(null, { status: 408 });
      if (!file.isFile() || file.size <= 0 || file.size !== entry.expectedSize || file.mtimeMs !== entry.expectedMtimeMs) {
        this.#revoke(token);
        return new Response(null, { status: 409 });
      }
      const range = parseRange(request.headers.get("range"), file.size);
      if (!range) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
      }
      const contentLength = range.end - range.start + 1;
      const headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Length": String(contentLength),
        "Content-Type": entry.mimeType,
        "Content-Security-Policy": "default-src 'none'",
        "X-Content-Type-Options": "nosniff",
      };
      if (range.partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${file.size}`;
      if (request.method === "HEAD") {
        return new Response(null, { status: range.partial ? 206 : 200, headers });
      }
      const stream = fileHandle.createReadStream({ start: range.start, end: range.end, autoClose: true });
      fileHandle = null; // Le flux devient responsable de la fermeture du fichier.
      entry.streams.add(stream);
      entry.expiresAt = this.#now() + TOKEN_TTL_MS;
      const abort = () => stream.destroy(new Error("Lecture annulée."));
      request.signal?.addEventListener("abort", abort, { once: true });
      stream.once("close", () => { entry.streams.delete(stream); request.signal?.removeEventListener("abort", abort); });
      return new Response(Readable.toWeb(stream), { status: range.partial ? 206 : 200, headers });
    } catch {
      return new Response(null, { status: 404 });
    } finally { await fileHandle?.close().catch(() => undefined); }
  }
}
