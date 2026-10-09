import tls from "node:tls";
import { castError, localHttp, sameNetwork, xmlEscape, xmlText } from "./cast-network.mjs";

const CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
const HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
const RECEIVER = "urn:x-cast:com.google.cast.receiver";
const MEDIA = "urn:x-cast:com.google.cast.media";
const MAX_FRAME = 64 * 1024;
const varint = (value) => { const bytes = []; do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value); return Buffer.from(bytes); };
const stringField = (number, value) => { const data = Buffer.from(value); return Buffer.concat([varint(number * 8 + 2), varint(data.length), data]); };

export function encodeCastMessage(namespace, destination, payload) {
  const data = Buffer.concat([Buffer.from([8, 0]), stringField(2, "sender-slyorrent"), stringField(3, destination), stringField(4, namespace), Buffer.from([40, 0]), stringField(6, JSON.stringify(payload))]);
  if (data.length > MAX_FRAME) throw castError("Commande Cast trop volumineuse.");
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}

export function decodeCastMessage(data) {
  if (data.length > MAX_FRAME) throw castError("Réponse Cast trop volumineuse.");
  let cursor = 0; const fields = {};
  const read = () => { let value = 0; for (let i = 0; i < 5; i++) { if (cursor >= data.length) throw castError("Réponse Cast invalide."); const byte = data[cursor++]; value += (byte & 127) * 2 ** (i * 7); if (!(byte & 128)) return value; } throw castError("Réponse Cast invalide."); };
  while (cursor < data.length) {
    const tag = read(), field = tag >>> 3, wire = tag & 7;
    if (wire === 0) fields[field] = read();
    else if (wire === 2) { const length = read(); if (cursor + length > data.length) throw castError("Réponse Cast invalide."); fields[field] = data.subarray(cursor, cursor + length).toString("utf8"); cursor += length; }
    else throw castError("Réponse Cast invalide.");
  }
  if (fields[1] !== 0 || fields[5] !== 0 || typeof fields[4] !== "string" || typeof fields[6] !== "string") throw castError("Réponse Cast invalide.");
  return { source: fields[2], destination: fields[3], namespace: fields[4], payload: JSON.parse(fields[6]) };
}

export class GoogleCastClient {
  #device; #socket; #pending = new Map(); #requestId = 0; #transport; #session; #mediaSession; #heartbeat; #lastPong = Date.now(); #closed = false;
  constructor(device) { this.#device = device; }
  async connect() {
    if (!sameNetwork(this.#device.address, this.#device.network)) throw castError("Appareil hors du réseau local.");
    // Les récepteurs Cast utilisent un certificat auto-signé. Cette exception
    // reste limitée à cette socket et à l'adresse privée choisie.
    const socket = this.#socket = tls.connect({ host: this.#device.address, port: 8009, localAddress: this.#device.network.address, rejectUnauthorized: false, minVersion: "TLSv1.2" });
    socket.setTimeout(12_000, () => socket.destroy(castError("Connexion Cast expirée.")));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32BE(0); if (!length || length > MAX_FRAME) throw castError("Réponse Cast invalide.");
          if (buffer.length < length + 4) break;
          const message = decodeCastMessage(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
          if (message.namespace === HEARTBEAT) {
            this.#lastPong = Date.now();
            if (message.payload?.type === "PING") this.#send(HEARTBEAT, message.source, { type: "PONG" });
          }
          const pending = this.#pending.get(message.payload?.requestId);
          if (pending && pending.namespace === message.namespace) {
            this.#pending.delete(message.payload.requestId); clearTimeout(pending.timer);
            if (["INVALID_REQUEST", "LOAD_FAILED", "LAUNCH_ERROR", "ERROR"].includes(message.payload.type)) pending.reject(castError("Commande Cast refusée."));
            else pending.resolve(message.payload);
          }
        }
        if (buffer.length > MAX_FRAME + 4) throw castError("Réponse Cast invalide.");
      } catch { socket.destroy(castError("Réponse Cast invalide.")); }
    });
    socket.on("error", () => this.#fail()); socket.on("close", () => this.#fail());
    await new Promise((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", () => reject(castError("Connexion Google Cast impossible."))); });
    this.#send(CONNECTION, "receiver-0", { type: "CONNECT" });
    this.#heartbeat = setInterval(() => { if (Date.now() - this.#lastPong > 15_000) this.close(); else this.#send(HEARTBEAT, "receiver-0", { type: "PING" }); }, 5000);
    this.#heartbeat.unref?.();
    const result = await this.#request(RECEIVER, "receiver-0", { type: "LAUNCH", appId: "CC1AD845" });
    const application = result.status?.applications?.find((item) => item.appId === "CC1AD845");
    if (!application?.transportId || !application?.sessionId) throw castError("Lecteur Google Cast indisponible.");
    this.#transport = application.transportId; this.#session = application.sessionId;
    this.#send(CONNECTION, this.#transport, { type: "CONNECT" });
  }
  #fail() { this.#closed = true; clearInterval(this.#heartbeat); for (const job of this.#pending.values()) { clearTimeout(job.timer); job.reject(castError("Appareil Cast déconnecté.")); } this.#pending.clear(); }
  #send(namespace, destination, payload) { if (!this.#closed && this.#socket?.writable) this.#socket.write(encodeCastMessage(namespace, destination, payload)); }
  #request(namespace, destination, payload) {
    if (this.#closed) return Promise.reject(castError("Appareil Cast déconnecté."));
    const requestId = ++this.#requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(requestId); reject(castError("L’appareil Cast ne répond pas.")); }, 10_000);
      this.#pending.set(requestId, { resolve, reject, timer, namespace }); this.#send(namespace, destination, { ...payload, requestId });
    });
  }
  async load(media, position) {
    const tracks = media.subtitleUrl ? [{ trackId: 1, type: "TEXT", trackContentId: media.subtitleUrl, trackContentType: "text/vtt", subtype: "SUBTITLES", name: "Sous-titres", language: media.language || "fr" }] : [];
    const result = await this.#request(MEDIA, this.#transport, { type: "LOAD", autoplay: true, currentTime: position, activeTrackIds: tracks.length ? [1] : [], media: { contentId: media.url, contentType: media.mimeType, streamType: "BUFFERED", duration: media.duration, metadata: { metadataType: 0, title: media.title }, tracks } });
    this.#mediaSession = result.status?.[0]?.mediaSessionId;
    if (!Number.isInteger(this.#mediaSession)) throw castError("Lecture Cast refusée.");
    return this.#status(result);
  }
  #status(result) {
    const item = result.status?.find((entry) => entry.mediaSessionId === this.#mediaSession);
    if (!item) throw castError("La lecture a été remplacée sur l’appareil.");
    return { playing: item.playerState === "PLAYING", buffering: item.playerState === "BUFFERING", position: Number(item.currentTime) || 0, duration: Number(item.media?.duration) || 0, ended: item.playerState === "IDLE" && item.idleReason === "FINISHED", stopped: item.playerState === "IDLE" && item.idleReason !== "FINISHED" };
  }
  async status() { return this.#status(await this.#request(MEDIA, this.#transport, { type: "GET_STATUS", mediaSessionId: this.#mediaSession })); }
  async command(action, value) {
    if (action === "volume") return this.#request(RECEIVER, "receiver-0", { type: "SET_VOLUME", volume: { level: value } });
    return this.#request(MEDIA, this.#transport, { type: { play: "PLAY", pause: "PAUSE", seek: "SEEK", stop: "STOP" }[action], mediaSessionId: this.#mediaSession, ...(action === "seek" ? { currentTime: value } : {}) });
  }
  async stop() { if (this.#transport && this.#session && !this.#closed) await this.command("stop").catch(() => undefined); this.close(); }
  close() { this.#fail(); this.#socket?.destroy(); }
}

const time = (seconds) => `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(Math.floor(seconds) % 60).padStart(2, "0")}`;
const seconds = (value) => /^\d{1,3}:\d{2}:\d{2}(?:\.\d+)?$/u.test(value) ? value.split(":").reduce((sum, part) => sum * 60 + Number(part), 0) : 0;
export class DlnaCastClient {
  #device; #uri = ""; #duration = 0; #position = 0; #played = false; #manualStop = false; #controller = new AbortController();
  constructor(device) { this.#device = device; }
  async connect() { /* SSDP a déjà validé la description et les services. */ }
  #soap(service, action, values) {
    const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service.type}">${Object.entries(values).map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`).join("")}</u:${action}></s:Body></s:Envelope>`;
    return localHttp(service.url, this.#device.network, { method: "POST", headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"${service.type}#${action}"`, "Content-Length": Buffer.byteLength(body) }, body, signal: this.#controller.signal });
  }
  async load(media, position) {
    this.#uri = media.url; this.#duration = media.duration; this.#position = 0; this.#played = false; this.#manualStop = false;
    const metadata = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:sec="http://www.sec.co.kr/"><item id="1" parentID="0" restricted="1"><dc:title>${xmlEscape(media.title)}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:${media.mimeType}:*" duration="${time(media.duration)}">${xmlEscape(media.url)}</res>${media.srtUrl ? `<sec:CaptionInfoEx sec:type="srt">${xmlEscape(media.srtUrl)}</sec:CaptionInfoEx>` : ""}</item></DIDL-Lite>`;
    await this.#soap(this.#device.transport, "SetAVTransportURI", { InstanceID: 0, CurrentURI: media.url, CurrentURIMetaData: metadata });
    await this.command("play");
    if (position > 0) await this.command("seek", position);
    return this.status();
  }
  async status() {
    const [transport, position] = await Promise.all([this.#soap(this.#device.transport, "GetTransportInfo", { InstanceID: 0 }), this.#soap(this.#device.transport, "GetPositionInfo", { InstanceID: 0 })]);
    const state = xmlText(transport, "CurrentTransportState"), uri = xmlText(position, "TrackURI");
    if (uri && uri !== this.#uri) throw castError("La lecture a été remplacée sur l’appareil.");
    const playing = state === "PLAYING", current = seconds(xmlText(position, "RelTime"));
    const duration = seconds(xmlText(position, "TrackDuration")) || this.#duration;
    const ended = state === "STOPPED" && this.#played && !this.#manualStop && duration > 0 && Math.max(current, this.#position) >= duration - 5;
    if (playing) this.#played = true;
    if (current > 0) this.#position = current;
    return { playing, buffering: state === "TRANSITIONING", position: current || this.#position, duration, ended, stopped: state === "STOPPED" && !ended && this.#played };
  }
  async command(action, value) {
    if (action === "volume") { if (!this.#device.rendering) throw castError("Volume non pris en charge par cet appareil."); return this.#soap(this.#device.rendering, "SetVolume", { InstanceID: 0, Channel: "Master", DesiredVolume: Math.round(value * 100) }); }
    if (action === "stop") this.#manualStop = true;
    return this.#soap(this.#device.transport, { play: "Play", pause: "Pause", seek: "Seek", stop: "Stop" }[action], { InstanceID: 0, ...(action === "play" ? { Speed: 1 } : action === "seek" ? { Unit: "REL_TIME", Target: time(value) } : {}) });
  }
  async stop() { await this.command("stop").catch(() => undefined); this.close(); }
  close() { this.#controller.abort(); }
}
