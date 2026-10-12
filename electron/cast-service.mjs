import { randomUUID } from "node:crypto";
import { CastGateway } from "./cast-gateway.mjs";
import { DlnaCastClient, GoogleCastClient } from "./cast-clients.mjs";
import { castError, castNetworks, discoverCastDevices, safeText } from "./cast-network.mjs";

const french = (language) => ["fr", "fre", "fra", "french"].includes(language);
const position = (value, duration = 86400) => Number.isFinite(value) ? Math.max(0, Math.min(value, duration || 86400)) : 0;
export function castQueue(value) {
  if (!Array.isArray(value) || !value.length || value.length > 250) throw castError("File de lecture invalide.");
  const seen = new Set();
  return value.map((item) => {
    if (!Number.isSafeInteger(item?.id) || item.id < 0 || !Number.isSafeInteger(item.fileIndex) || item.fileIndex < 0 || seen.has(`${item.id}:${item.fileIndex}`)) throw castError("File de lecture invalide.");
    seen.add(`${item.id}:${item.fileIndex}`); return { id: item.id, fileIndex: item.fileIndex, title: safeText(item.title) || "Vidéo" };
  });
}

/** Une session, un appareil, deux médias au maximum. Aucun catalogue réseau. */
export class CastService {
  #service; #vault; #history; #audit; #sleep; #session; #devices = new Map(); #networks = new Map(); #discovery; #discovering; #lastError = ""; #environment;
  constructor({ service, vault, history, audit, sleep = () => undefined, networks = castNetworks, discover = discoverCastDevices, gateway = (options) => new CastGateway(options), client = (device) => device.kind === "chromecast" ? new GoogleCastClient(device) : new DlnaCastClient(device) }) { this.#service = service; this.#vault = vault; this.#history = history; this.#audit = audit; this.#sleep = sleep; this.#environment = { networks, discover, gateway, client }; }
  async discover() {
    if (this.#discovering) return this.#discovering;
    this.#discovery = new AbortController();
    const networks = this.#environment.networks(); this.#networks = new Map(networks.map((item) => [item.id, item]));
    this.#discovering = this.#environment.discover(networks, this.#discovery.signal).then((devices) => {
      this.#devices = new Map(devices.map((device) => [device.id, device]));
      return { devices: devices.map(({ id, kind, name, model }) => ({ id, kind, name, model })), networks: networks.map(({ id, name, address }) => ({ id, name, address })) };
    }).finally(() => { this.#discovering = null; });
    return this.#discovering;
  }
  status(owner) {
    const s = this.#session;
    if (!s || s.owner !== owner) return { active: false, error: this.#lastError };
    const item = s.queue[s.index];
    return { active: true, kind: s.kind, deviceName: s.deviceName, item, queue: s.queue, index: s.index, total: s.queue.length, phase: s.phase, nextPrepared: Boolean(s.prepared.get(s.index + 1)?.ready), loading: s.loading, playing: s.playing, buffering: s.buffering, position: s.position, duration: s.duration, volume: s.volume, volumeSupported: s.volumeSupported, autoNext: s.autoNext, error: s.error, preparation: s.primary ? this.#service.mediaPreparation(s.primary, owner) : null, receiverUrl: s.kind === "browser" ? s.gateway.receiverUrl : undefined, pairingCode: s.gateway.code || undefined, paired: s.kind !== "browser" || s.gateway.paired, audioTracks: s.current?.access.audioTracks || [], subtitleTracks: s.current?.access.subtitleTracks || [], selectedAudioTrack: s.current?.access.selectedAudioTrack ?? null, selectedSubtitleTrack: s.current?.subtitleIndex ?? null, watchRecord: s.watchRecord };
  }
  async start(params, owner) {
    const queue = castQueue(params.queue);
    if (!Number.isInteger(params.index) || params.index < 0 || params.index >= queue.length || typeof params.autoNext !== "boolean") throw castError("Options de cast invalides.");
    const device = this.#devices.get(params.deviceId), browser = params.kind === "browser";
    const network = browser ? this.#networks.get(params.networkId) : device?.network;
    if (!network || !this.#environment.networks().some((item) => item.id === network.id) || !browser && (!device || Date.now() - device.seenAt > 120_000)) throw castError("Actualisez la liste des appareils.");
    if (params.audioTrack !== undefined && !Number.isInteger(params.audioTrack) || params.subtitleTrack !== undefined && params.subtitleTrack !== null && !Number.isInteger(params.subtitleTrack)) throw castError("Choix de piste invalide.");
    await this.stop(owner); this.#lastError = "";
    const s = { owner, queue, index: params.index, kind: browser ? "browser" : device.kind, deviceName: browser ? "Écran connecté" : device.name, autoNext: params.autoNext, phase: "connecting", loading: true, playing: false, buffering: false, position: position(params.position), duration: 0, volumeSupported: browser || device.kind === "chromecast" || Boolean(device.rendering), error: "", requests: new Set(), prepared: new Map(), failures: 0, version: 0, epoch: randomUUID(), lastReport: Date.now(), lastSave: 0, subtitlesEnabled: params.subtitleTrack !== null };
    this.#session = s;
    s.gateway = this.#environment.gateway({ network, deviceAddress: device?.address, vault: this.#vault, owner, state: () => ({ epoch: s.epoch, version: s.version, command: s.command, media: s.current?.media, loading: s.loading, error: s.error, position: s.position, playing: s.playing }), report: (value) => this.#report(s, value), onPair: () => { s.lastReport = Date.now(); } });
    try {
      await s.gateway.start();
      if (this.#session !== s) { await s.gateway.close(); throw castError("Cast arrêté."); }
      s.client = browser ? null : this.#environment.client(device);
      s.timer = setInterval(() => { void this.#tick(s); }, 1500); s.timer.unref?.(); this.#sleep(true);
      void (async () => { await s.client?.connect(); await this.#load(s, s.index, s.position, { audioTrack: params.audioTrack, subtitleTrack: params.subtitleTrack }); })().catch((error) => this.#fail(s, error));
      await this.#audit.append("cast.started", { kind: s.kind, queueLength: queue.length }).catch(() => undefined);
      return this.status(owner);
    } catch (error) { await this.#fail(s, error); throw error; }
  }
  async #prepare(s, index, tracks = {}) {
    const item = s.queue[index], requestId = randomUUID(); s.requests.add(requestId); if (index === s.index) s.primary = requestId;
    let access;
    try {
      access = await this.#service.openMedia({ ...item, purpose: "cast", requestId, audioTrack: tracks.audioTrack, preferredAudioLanguage: s.audioLanguage }, s.owner);
      if (this.#session !== s) throw castError("Cast arrêté.");
      const subtitles = (access.subtitleTracks || []).filter((track) => track.supported);
      let chosen = null;
      if (s.subtitlesEnabled) chosen = tracks.subtitleTrack === undefined
        ? subtitles.find((track) => s.subtitleLanguage && track.language === s.subtitleLanguage) ?? subtitles.find((track) => french(track.language) && (!french(access.audioLanguage) || track.forced)) ?? subtitles.find((track) => track.default || track.forced)
        : subtitles.find((track) => track.index === tracks.subtitleTrack);
      if (tracks.subtitleTrack !== undefined && tracks.subtitleTrack !== null && !chosen) throw castError("Piste de sous-titres indisponible.");
      let vtt;
      if (chosen) {
        const subtitleRequest = randomUUID(); s.requests.add(subtitleRequest);
        try { vtt = (await this.#service.openSubtitle({ ...item, trackIndex: chosen.index, requestId: subtitleRequest }, s.owner)).vtt; } finally { s.requests.delete(subtitleRequest); }
      }
      if (this.#session !== s) throw castError("Cast arrêté.");
      const reference = await this.#service.mediaReference(item);
      if (this.#session !== s) throw castError("Cast arrêté.");
      const links = s.gateway.addMedia(access, vtt);
      return { access, resourceId: links.resourceId, subtitleIndex: chosen?.index ?? null, subtitleLanguage: chosen?.language, reference, media: { url: links.url, subtitleUrl: links.subtitleUrl, srtUrl: links.srtUrl, title: item.title, mimeType: access.mimeType, duration: access.duration, language: chosen?.language } };
    } catch (error) { if (access) this.#vault.release(access.url, s.owner); throw error; }
    finally { s.requests.delete(requestId); if (s.primary === requestId) s.primary = null; }
  }
  #drop(s, entry) { if (!entry) return; s.gateway.remove(entry.resourceId); this.#vault.release(entry.access.url, s.owner); }
  async #load(s, index, start, tracks) {
    if (this.#session !== s || s.transition) return;
    s.transition = true; s.loading = true; s.phase = "preparing"; s.playing = false; s.controlRevision = (s.controlRevision || 0) + 1; this.#sleep(true);
    try {
      await this.#save(s); s.index = index; s.position = position(start); s.duration = 0;
      for (const [key, job] of s.prepared) if (key !== index && key !== index + 1) { s.prepared.delete(key); void job.then((entry) => this.#drop(s, entry)); }
      if (s.current) { if (s.client) await s.client.command("pause").catch(() => undefined); else { s.command = { action: "pause" }; s.version++; } }
      const entry = tracks ? await this.#prepare(s, index, tracks) : await (s.prepared.get(index) || Promise.resolve(null)) || await this.#prepare(s, index);
      s.prepared.delete(index);
      if (this.#session !== s) { this.#drop(s, entry); return; }
      this.#drop(s, s.current); s.current = entry; s.audioLanguage = entry.access.audioLanguage; s.subtitleLanguage = entry.subtitleLanguage;
      s.epoch = randomUUID(); s.finishedEpoch = null; s.version++; s.command = null; s.duration = entry.access.duration; s.position = position(start, s.duration); s.playing = !s.client; s.buffering = false; s.phase = "loading"; s.lastReport = Date.now(); s.watchRecord = undefined;
      const remote = s.client ? await s.client.load(entry.media, s.position) : null;
      if (this.#session !== s) return;
      s.loading = false;
      if (remote) this.#update(s, remote);
      this.#warm(s);
    } finally { s.transition = false; }
  }
  #warm(s) {
    const index = s.index + 1;
    if (!s.autoNext || index >= s.queue.length || s.prepared.has(index) || this.#session !== s) return;
    const job = this.#prepare(s, index).then((entry) => { if (this.#session !== s || !s.autoNext || index !== s.index + 1 && !(s.transition && index === s.index) || s.prepared.get(index) !== job) { this.#drop(s, entry); return null; } job.ready = entry; return entry; }).catch(() => { if (s.prepared.get(index) === job) s.prepared.delete(index); return null; });
    s.prepared.set(index, job);
  }
  async #save(s, completed = false) {
    if (!s.current || !s.duration) return;
    s.lastSave = Date.now();
    try { s.watchRecord = await this.#history.update(s.current.reference.hash, s.current.reference.fileIndex, { position: completed ? s.duration : s.position, duration: s.duration, completed: completed || s.finishedEpoch === s.epoch }); }
    catch { s.error = "Position de lecture non enregistrée."; }
  }
  #update(s, value) {
    if (this.#session !== s || s.loading) return;
    if (Number.isFinite(value.volume) && value.volume >= 0 && value.volume <= 1) s.volume = value.volume;
    s.position = position(value.position, s.duration); s.playing = Boolean(value.playing); s.buffering = Boolean(value.buffering); this.#sleep(s.playing || s.buffering);
    if (value.ended && !s.finishing && s.finishedEpoch !== s.epoch) {
      s.finishing = true; s.finishedEpoch = s.epoch;
      void this.#save(s, true).then(async () => {
        if (this.#session !== s) return;
        if (s.autoNext && s.index + 1 < s.queue.length) await this.#load(s, s.index + 1, 0);
        else { s.playing = false; s.position = s.duration; }
      }).catch((error) => this.#fail(s, error)).finally(() => { s.finishing = false; });
    } else if (value.stopped) void this.stop(s.owner);
  }
  #report(s, data) {
    if (this.#session !== s || s.kind !== "browser" || data.epoch !== s.epoch || data.version !== s.version || typeof data.playing !== "boolean" || typeof data.ended !== "boolean") return;
    s.lastReport = Date.now();
    if (data.failed) { void this.#fail(s, castError("Ce navigateur ne peut pas lire la vidéo.")); return; }
    this.#update(s, { ...data, ended: data.ended && data.position >= s.duration - 2 });
  }
  async #tick(s) {
    if (this.#session !== s || s.polling) return; s.polling = true;
    try {
      if (s.kind === "browser" && (!s.gateway.paired && Date.now() > s.gateway.expiresAt || s.gateway.paired && Date.now() - s.lastReport > 30_000)) throw castError("Écran déconnecté. Relancez le cast.");
      if (s.current) {
        await this.#vault.renew(s.current.access.url, s.owner);
        for (const job of s.prepared.values()) if (job.ready) await this.#vault.renew(job.ready.access.url, s.owner);
        if (!s.loading && s.client) { const revision = s.controlRevision; const remote = await s.client.status(); if (s.controlRevision === revision) this.#update(s, remote); }
        if (Date.now() - s.lastSave > 5000 && !s.loading) await this.#save(s);
      }
      s.failures = 0;
    } catch (error) { if (++s.failures >= 3 || !s.client) await this.#fail(s, error); }
    finally { s.polling = false; }
  }
  async control(params, owner) {
    const s = this.#session; if (!s || s.owner !== owner) throw castError("Aucun cast en cours.");
    if (params.action === "stop") { await this.stop(owner); return this.status(owner); }
    if (params.action === "autoNext") { if (typeof params.value !== "boolean") throw castError("Option invalide."); s.autoNext = params.value; if (s.autoNext) this.#warm(s); else if (!s.loading) { for (const request of s.requests) this.#service.cancelMediaPreparation(request, s.owner); for (const job of s.prepared.values()) void job.then((entry) => this.#drop(s, entry)); s.prepared.clear(); } return this.status(owner); }
    if (s.loading || s.transition) throw castError("Vidéo en préparation.");
    if (["next", "previous", "episode", "tracks"].includes(params.action)) {
      if (params.action === "episode" && !Number.isInteger(params.value)) throw castError("Épisode invalide.");
      const index = params.action === "episode" ? params.value : s.index + (params.action === "next" ? 1 : params.action === "previous" ? -1 : 0);
      if (index < 0 || index >= s.queue.length) throw castError("Fin de la file de lecture.");
      if (params.action !== "tracks" && index === s.index) return this.status(owner);
      if (params.action === "tracks") {
        if (params.audioTrack !== undefined && !s.current.access.audioTracks.some((track) => track.index === params.audioTrack) || params.subtitleTrack !== undefined && params.subtitleTrack !== null && !s.current.access.subtitleTracks.some((track) => track.index === params.subtitleTrack && track.supported)) throw castError("Piste introuvable.");
        s.subtitlesEnabled = params.subtitleTrack === undefined ? s.subtitlesEnabled : params.subtitleTrack !== null;
        for (const request of s.requests) this.#service.cancelMediaPreparation(request, s.owner);
        for (const [key, job] of s.prepared) { s.prepared.delete(key); void job.then((entry) => this.#drop(s, entry)); }
      }
      void this.#load(s, index, params.action === "tracks" ? s.position : 0, params.action === "tracks" ? { audioTrack: params.audioTrack ?? s.current.access.selectedAudioTrack ?? undefined, subtitleTrack: params.subtitleTrack === undefined ? s.current.subtitleIndex : params.subtitleTrack } : undefined).catch((error) => this.#fail(s, error));
    } else if (["play", "pause", "seek", "volume"].includes(params.action)) {
      if (["seek", "volume"].includes(params.action) && (!Number.isFinite(params.value) || params.value < 0 || params.value > (params.action === "volume" ? 1 : s.duration))) throw castError("Valeur invalide.");
      s.controlRevision = (s.controlRevision || 0) + 1;
      if (s.client) await s.client.command(params.action, params.value); else { s.command = { action: params.action, value: params.value }; s.version++; }
      if (params.action === "play" || params.action === "pause") s.playing = params.action === "play";
      if (params.action === "seek") s.position = params.value;
      if (params.action === "volume") s.volume = params.value;
      if (params.action === "pause") await this.#save(s);
    } else throw castError("Commande de cast invalide.");
    return this.status(owner);
  }
  async #fail(s, error) { if (this.#session !== s) return; await this.stop(s.owner); this.#lastError = safeText(error?.message) || "Cast interrompu."; await this.#audit.append("cast.failed", { kind: s.kind, reason: safeText(error?.code || "CAST_FAILED", 64) }).catch(() => undefined); }
  async stop(owner) {
    const s = this.#session; if (!s || owner !== undefined && s.owner !== owner) return;
    this.#session = null; clearInterval(s.timer); this.#sleep(false);
    for (const requestId of s.requests) this.#service.cancelMediaPreparation(requestId, s.owner);
    await this.#save(s); this.#drop(s, s.current);
    for (const job of s.prepared.values()) void job.then((entry) => this.#drop(s, entry)); s.prepared.clear();
    await s.gateway.close(); await s.client?.stop();
    await this.#audit.append("cast.stopped", { kind: s.kind }).catch(() => undefined);
  }
  async close() { this.#discovery?.abort(); await this.stop(); }
}
