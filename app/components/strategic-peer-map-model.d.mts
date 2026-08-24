export const MAP_WIDTH: 1000;
export const MAP_HEIGHT: 520;
export const MAX_RENDERED_PEERS: 512;

export type MapPoint = Readonly<{ x: number; y: number }>;
export type MapViewport = Readonly<{ x: number; y: number; k: number }>;

export type NormalizedLocalNode = Readonly<{
  latitude: number;
  longitude: number;
  point: MapPoint;
  source: "windows-location-service" | "manual";
  accuracyKm: number | null;
  approximate: boolean;
}>;

export type NormalizedStrategicPeer = Readonly<{
  id: string;
  label: string;
  torrentId: number | null;
  torrentName: string;
  countryCode: string | null;
  country: string | null;
  city: string | null;
  latitude: number;
  longitude: number;
  point: MapPoint;
  rateDownload: number;
  rateUpload: number;
  active: boolean;
  progress: number;
  encrypted: boolean;
  connection: "incoming" | "outgoing";
  direction: "download" | "upload" | "bidirectional" | "inactive";
}>;

export function safeDisplayText(value: unknown, maximumLength?: number): string | null;
export function projectCoordinate(latitude: unknown, longitude: unknown): MapPoint | null;
export function normalizeLocalNode(value: unknown): NormalizedLocalNode | null;
export function normalizePeers(value: unknown): readonly NormalizedStrategicPeer[];
export function rateVisual(rate: unknown, maximumRate: unknown): Readonly<{
  strokeWidth: number;
  opacity: number;
  durationSeconds: number;
}>;
export function createArcPath(from: unknown, to: unknown, bendSign?: number): string | null;
export function clampViewport(value: unknown): MapViewport;
export function centerViewport(point: unknown, scale?: unknown): MapViewport;
export function zoomViewport(viewport: unknown, nextScale: unknown, anchor?: unknown): MapViewport;
export function formatRate(value: unknown): string;
