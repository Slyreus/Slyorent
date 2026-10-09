import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { castError, normalizedAddress, sameNetwork } from "./cast-network.mjs";

const secret = () => randomBytes(32).toString("base64url");
const equal = (a, b) => typeof a === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class CastGateway {
  #network; #vault; #owner; #server; #address; #allowed; #assets = new Map(); #resources = new Map(); #buckets = new Map(); #code; #codeUntil; #attempts = 0; #bearer; #state; #report; #onPair; #closed = false;
  constructor({ network, deviceAddress, vault, owner, state, report, onPair }) { this.#network = network; this.#allowed = deviceAddress || null; this.#vault = vault; this.#owner = owner; this.#state = state; this.#report = report; this.#onPair = onPair; }
  get receiverUrl() { return `${this.#address}/watch`; }
  get code() { return this.#code; }
  get paired() { return Boolean(this.#bearer); }
  get expiresAt() { return this.#codeUntil; }
  async start() {
    if (!sameNetwork(this.#network.address, this.#network)) throw castError("Aucun réseau privé utilisable.");
    for (const [name, type] of [["index.html", "text/html; charset=utf-8"], ["receiver.js", "text/javascript; charset=utf-8"], ["receiver.css", "text/css; charset=utf-8"]]) this.#assets.set(name, { type, body: await readFile(new URL(`./cast-receiver/${name}`, import.meta.url)) });
    if (this.#closed) throw castError("Cast arrêté.");
    if (!this.#allowed) { this.#code = String(randomInt(10_000_000, 100_000_000)); this.#codeUntil = Date.now() + 120_000; }
    const server = this.#server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => { void this.#handle(request, response).catch(() => { if (!response.headersSent) this.#json(response, 400, { error: "Requête refusée." }); else response.destroy(); }); });
    server.maxConnections = 12; server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
    server.on("clientError", (_error, socket) => socket.destroy()); server.on("error", () => undefined);
    await new Promise((resolve, reject) => { server.once("error", () => reject(castError("Accès au réseau local impossible."))); server.listen(0, this.#network.address, resolve); });
    if (this.#closed) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); throw castError("Cast arrêté."); }
    this.#address = `http://${this.#network.address}:${server.address().port}`;
  }
  addMedia(access, vtt) {
    const id = secret(); this.#resources.set(id, { access, vtt });
    return { url: `${this.#address}/m/${id}`, subtitleUrl: vtt ? `${this.#address}/s/${id}` : undefined, srtUrl: vtt ? `${this.#address}/t/${id}` : undefined, resourceId: id };
  }
  remove(id) { this.#resources.delete(id); }
  #json(response, status, value) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value)); }
  async #body(request) { let size = 0; const chunks = []; for await (const chunk of request) { size += chunk.length; if (size > 8192) throw castError("Requête trop volumineuse."); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  #authorize(request) { return this.#bearer && equal(request.headers.authorization, `Bearer ${this.#bearer}`) && request.headers.origin === this.#address; }
  async #handle(request, response) {
    response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("Referrer-Policy", "no-referrer");
    const address = normalizedAddress(request.socket.remoteAddress);
    if (!sameNetwork(address, this.#network) || request.headers.host !== new URL(this.#address).host || (this.#allowed && address !== this.#allowed)) { this.#json(response, 403, { error: "Appareil refusé." }); return; }
    const bucket = this.#buckets.get(address) || { at: Date.now(), count: 0 };
    if (Date.now() - bucket.at >= 60_000) { bucket.at = Date.now(); bucket.count = 0; }
    if (++bucket.count > 400 || this.#buckets.size >= 64 && !this.#buckets.has(address)) { this.#json(response, 429, { error: "Trop de requêtes." }); return; }
    this.#buckets.set(address, bucket);
    if (!["GET", "HEAD", "POST", "OPTIONS"].includes(request.method)) { this.#json(response, 405, {}); return; }
    const url = new URL(request.url, this.#address);
    if (url.origin !== this.#address || url.search || url.hash || url.username || url.password) { this.#json(response, 400, {}); return; }
    const match = /^\/([mst])\/([A-Za-z0-9_-]{43})$/u.exec(url.pathname);
    if (match && this.#allowed) {
      response.setHeader("Access-Control-Allow-Origin", "*"); response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"); response.setHeader("Access-Control-Allow-Headers", "Range"); response.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
      if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
      if (!["GET", "HEAD"].includes(request.method)) { this.#json(response, 405, {}); return; }
      const item = this.#resources.get(match[2]); if (!item) { this.#json(response, 404, {}); return; }
      await this.#vault.renew(item.access.url, this.#owner);
      if (match[1] !== "m") {
        if (!item.vtt) { this.#json(response, 404, {}); return; }
        const body = Buffer.from(match[1] === "s" ? item.vtt : item.vtt.replace(/^WEBVTT[^\n]*\n/u, "").replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/gu, "$1,$2"));
        response.writeHead(200, { "Content-Type": match[1] === "s" ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8", "Content-Length": body.length }); response.end(request.method === "HEAD" ? undefined : body); return;
      }
      const controller = new AbortController(); request.once("aborted", () => controller.abort()); response.once("close", () => { if (!response.writableEnded) controller.abort(); });
      const served = await this.#vault.handle({ url: item.access.url, method: request.method, headers: new Headers({ ...(request.headers.range ? { Range: request.headers.range } : {}) }), signal: controller.signal, webContentsId: this.#owner });
      for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) if (served.headers.has(header)) response.setHeader(header, served.headers.get(header));
      response.writeHead(served.status);
      if (served.body && request.method !== "HEAD") await pipeline(Readable.fromWeb(served.body), response); else response.end();
      return;
    }
    if (url.pathname === "/api/pair" && request.method === "POST" && request.headers.origin === this.#address && !this.#allowed) {
      if (Date.now() > this.#codeUntil || ++this.#attempts > 8) { this.#json(response, 403, { error: "Code expiré. Relancez le cast sur le PC." }); return; }
      const data = await this.#body(request);
      if (!equal(String(data.code || ""), this.#code)) { this.#json(response, 403, { error: "Code incorrect." }); return; }
      this.#allowed = address; this.#bearer = secret(); this.#code = null; this.#onPair?.();
      this.#json(response, 200, { token: this.#bearer }); return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (!this.#authorize(request)) { this.#json(response, 403, {}); return; }
      if (url.pathname === "/api/state" && request.method === "POST") this.#json(response, 200, this.#state());
      else if (url.pathname === "/api/report" && request.method === "POST") { this.#report(await this.#body(request)); this.#json(response, 200, { ok: true }); }
      else this.#json(response, 404, {});
      return;
    }
    const asset = this.#assets.get({ "/watch": "index.html", "/receiver.js": "receiver.js", "/receiver.css": "receiver.css" }[url.pathname]);
    if (!asset || !["GET", "HEAD"].includes(request.method)) { this.#json(response, 404, {}); return; }
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.writeHead(200, { "Content-Type": asset.type, "Content-Length": asset.body.length }); response.end(request.method === "HEAD" ? undefined : asset.body);
  }
  async close() { this.#closed = true; this.#resources.clear(); this.#bearer = null; this.#code = null; if (this.#server) { this.#server.closeAllConnections(); await new Promise((resolve) => this.#server.close(resolve)); } }
}
