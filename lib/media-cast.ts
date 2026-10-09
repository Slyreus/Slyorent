import type { MediaTrack, WatchRecord } from "./media-playback";
export type CastItem = { id: number; fileIndex: number; title: string };
export type CastRequest = { queue: CastItem[]; index: number; position: number; audioTrack?: number; subtitleTrack?: number | null };
export type CastDevice = { id: string; kind: "chromecast" | "dlna"; name: string; model: string };
export type CastDiscovery = { devices: CastDevice[]; networks: { id: string; name: string; address: string }[] };
export type CastStatus = { active: boolean; error?: string; kind?: "chromecast" | "dlna" | "browser"; deviceName?: string; item?: CastItem; index?: number; total?: number; loading?: boolean; playing?: boolean; buffering?: boolean; position?: number; duration?: number; autoNext?: boolean; preparation?: SecuTorrentMediaPreparation | null; receiverUrl?: string; pairingCode?: string; paired?: boolean; audioTracks?: MediaTrack[]; subtitleTracks?: MediaTrack[]; selectedAudioTrack?: number | null; selectedSubtitleTrack?: number | null; watchRecord?: WatchRecord & { key: string } };
export type CastControl = { action: "play" | "pause" | "seek" | "stop" | "next" | "previous" | "volume" | "autoNext" | "tracks"; value?: number | boolean; audioTrack?: number; subtitleTrack?: number | null };
export type CastStart = CastRequest & { kind?: "browser"; deviceId?: string; networkId?: string; autoNext: boolean };
