import type { MediaEpisode } from "./media-library";

export type WatchRecord = { position: number; duration: number; completed: boolean; updatedAt: number };
export type MediaTrack = { index: number; language: string; title: string; codec: string; default: boolean; forced: boolean; channels?: number; supported?: boolean };
export type MediaAccess = { url: string; mimeType: string; expiresAt: string; audioAdapted?: boolean; audioCodec?: string | null; audioLanguage?: string | null; videoAdapted?: boolean; videoCodec?: string | null; audioTracks?: MediaTrack[]; subtitleTracks?: MediaTrack[]; selectedAudioTrack?: number | null };
type PlaybackBridge = {
  openMedia: (options: { id: number; fileIndex: number; purpose: "playback"; requestId: string; audioTrack?: number }) => Promise<MediaAccess>;
  openSubtitle?: (options: { id: number; fileIndex: number; trackIndex: number; requestId: string }) => Promise<{ vtt: string }>;
  renewMedia: (url: string) => Promise<{ expiresAt: string }>;
  releaseMedia: (url: string) => Promise<{ ok: true }>;
  cancelMediaPreparation: (requestId: string) => Promise<{ ok: true }>;
  mediaPreparation?: (requestId: string) => Promise<SecuTorrentMediaPreparation | null>;
};

const LANGUAGE_ALIASES: Record<string, string> = { fre: "fr", fra: "fr", french: "fr", eng: "en", english: "en", jpn: "ja", japanese: "ja", ger: "de", deu: "de", spa: "es", ita: "it", por: "pt", rus: "ru", kor: "ko", chi: "zh", zho: "zh", ara: "ar", dut: "nl", nld: "nl" };
export function trackLanguage(language: string) { return LANGUAGE_ALIASES[language.toLowerCase()] || language.toLowerCase(); }
export function trackLabel(track: MediaTrack) {
  const language = trackLanguage(track.language);
  let name = "Langue inconnue";
  try { if (language !== "und") name = new Intl.DisplayNames(["fr"], { type: "language" }).of(language) || name; } catch { /* Métadonnée non reconnue. */ }
  name = name.charAt(0).toLocaleUpperCase("fr") + name.slice(1);
  return [name, track.title, track.forced ? "Forcés" : "", track.channels ? `${track.channels} canaux` : "", track.supported === false ? "Format non pris en charge" : ""].filter(Boolean).join(" · ");
}
export function defaultSubtitleTrack(tracks: readonly MediaTrack[], audioLanguage?: string | null) {
  const supported = tracks.filter((track) => track.supported !== false);
  const french = supported.filter((track) => trackLanguage(track.language) === "fr");
  if (trackLanguage(audioLanguage || "und") === "fr") return french.find((track) => track.forced)?.index ?? null;
  return (french.find((track) => !track.forced) ?? french[0] ?? supported.find((track) => track.default) ?? supported.find((track) => track.forced))?.index ?? null;
}

export function formatMediaTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value % 60).toString().padStart(2, "0");
  const minutes = Math.floor(value / 60) % 60;
  const hours = Math.floor(value / 3600);
  return hours > 0 ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function watchPercentage(record?: WatchRecord) {
  if (record?.completed) return 100;
  if (!record || !Number.isFinite(record.duration) || record.duration <= 0 || !Number.isFinite(record.position)) return 0;
  return Math.max(0, Math.min(99, Math.floor(record.position / record.duration * 100)));
}

export function canResume(record?: WatchRecord) {
  return Boolean(record && !record.completed && Number.isFinite(record.position) && record.position > 0 && record.position < record.duration);
}

export function isLocalMediaUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "secutorrent-media:" && url.hostname === "stream"
      && /^[A-Za-z0-9_-]{43}$/u.test(url.pathname.slice(1))
      && !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch { return false; }
}

/** Une seule préparation anticipée, partagée avec l'ouverture de l'épisode suivant. */
export class MediaPlaybackSession {
  private bridge: PlaybackBridge;
  private closed = false;
  private held = new Set<string>();
  private pending = new Map<string, { key: string; cancelled: boolean; subtitle?: boolean }>();
  private warm: { key: string; promise: Promise<MediaAccess | null> } | null = null;

  constructor(bridge: PlaybackBridge) { this.bridge = bridge; }

  private async prepare(episode: MediaEpisode, audioTrack?: number) {
    if (this.closed) throw new Error("Lecteur fermé.");
    const requestId = crypto.randomUUID();
    const pending = { key: episode.key, cancelled: false };
    this.pending.set(requestId, pending);
    try {
      const access = await this.bridge.openMedia({ id: episode.torrentId, fileIndex: episode.fileIndex, purpose: "playback", requestId, ...(audioTrack === undefined ? {} : { audioTrack }) });
      if (!isLocalMediaUrl(access.url)) throw new Error("Flux local refusé.");
      if (this.closed || pending.cancelled) {
        await this.bridge.releaseMedia(access.url).catch(() => undefined);
        throw new Error("Lecteur fermé.");
      }
      this.held.add(access.url);
      return access;
    } finally { this.pending.delete(requestId); }
  }

  cancelOpen(episodeKey: string) {
    for (const [requestId, pending] of this.pending) {
      if (pending.key === episodeKey && !pending.cancelled) {
        pending.cancelled = true;
        void this.bridge.cancelMediaPreparation(requestId).catch(() => undefined);
      }
    }
  }

  async take(episode: MediaEpisode): Promise<MediaAccess> {
    if (this.closed) throw new Error("Lecteur fermé.");
    const warm = this.warm;
    this.warm = null;
    if (warm?.key === episode.key) {
      const access = await warm.promise;
      if (this.closed) throw new Error("Lecteur fermé.");
      if (access) {
        try { await this.bridge.renewMedia(access.url); return access; }
        catch { this.release(access); }
      }
    } else if (warm) {
      this.cancelOpen(warm.key);
      void warm.promise.then((access) => { if (access) this.release(access); });
    }
    return this.prepare(episode);
  }

  reopen(episode: MediaEpisode, audioTrack?: number) { return this.prepare(episode, audioTrack); }

  async subtitle(episode: MediaEpisode, trackIndex: number) {
    if (this.closed || !this.bridge.openSubtitle) throw new Error("Sous-titres indisponibles.");
    const requestId = crypto.randomUUID();
    const pending = { key: episode.key, cancelled: false, subtitle: true };
    this.pending.set(requestId, pending);
    try {
      const { vtt } = await this.bridge.openSubtitle({ id: episode.torrentId, fileIndex: episode.fileIndex, trackIndex, requestId });
      if (this.closed || pending.cancelled) throw new Error("Lecteur fermé.");
      if (typeof vtt !== "string" || vtt.length > 2 * 1024 * 1024 || !vtt.startsWith("WEBVTT")) throw new Error("Sous-titres invalides.");
      return vtt;
    } finally { this.pending.delete(requestId); }
  }

  cancelSubtitles(episodeKey: string) {
    for (const [requestId, pending] of this.pending) {
      if (pending.key === episodeKey && pending.subtitle && !pending.cancelled) {
        pending.cancelled = true;
        void this.bridge.cancelMediaPreparation(requestId).catch(() => undefined);
      }
    }
  }

  async progress(episodeKey: string) {
    if (!this.bridge.mediaPreparation || this.closed) return null;
    const request = [...this.pending].find(([, pending]) => pending.key === episodeKey && !pending.cancelled && !pending.subtitle);
    return request ? this.bridge.mediaPreparation(request[0]) : null;
  }

  async prewarm(episode: MediaEpisode) {
    if (this.closed || !episode.playable) return false;
    if (this.warm?.key !== episode.key) {
      const previous = this.warm;
      if (previous) { this.cancelOpen(previous.key); void previous.promise.then((access) => { if (access) this.release(access); }); }
      this.warm = { key: episode.key, promise: this.prepare(episode).catch(() => null) };
    }
    return Boolean(await this.warm.promise);
  }

  async keepWarm() {
    const warm = this.warm;
    if (!warm) return;
    const access = await warm.promise;
    if (access && this.warm === warm) {
      try { await this.bridge.renewMedia(access.url); }
      catch { this.release(access); if (this.warm === warm) this.warm = null; }
    }
  }

  release(access: MediaAccess) {
    if (!this.held.delete(access.url)) return;
    void this.bridge.releaseMedia(access.url).catch(() => undefined);
  }

  dispose() {
    this.closed = true;
    for (const pending of this.pending.values()) this.cancelOpen(pending.key);
    this.warm = null;
    for (const url of this.held) this.release({ url, mimeType: "", expiresAt: "" });
  }
}
