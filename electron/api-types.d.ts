export {};

declare global {
  interface SecuTorrentWatchRecord {
    position: number;
    duration: number;
    completed: boolean;
    updatedAt: number;
  }
  type SecuTorrentWatchHistory = Record<string, SecuTorrentWatchRecord>;
  type SecuTorrentScanStatus = "not-scanned" | "scanning" | "clean" | "blocked" | "stale";
  interface SecuTorrentFile {
    index: number;
    name: string;
    length: number;
    bytesCompleted: number;
    wanted: boolean;
    media: boolean;
    scanStatus: SecuTorrentScanStatus;
  }
  interface SecuTorrentPeer {
    id: string;
    label: string;
    countryCode: string | null;
    country: string | null;
    city: string | null;
    latitude: number | null;
    longitude: number | null;
    locationStatus: "resolved" | "unavailable";
    rateDownload: number;
    rateUpload: number;
    progress: number;
    active: boolean;
    encrypted: boolean;
    connection: "incoming" | "outgoing";
    direction: "download" | "upload" | "bidirectional" | "inactive";
  }
  interface SecuTorrentPeerSnapshotItem extends SecuTorrentPeer {
    torrentId: number;
    torrentName: string;
  }
  interface SecuTorrentLocalLocation {
    status: "unavailable";
    source: "none";
    approximate: true;
    local: true;
    timeZone: string;
    latitude: null;
    longitude: null;
    reason: "explicit-location-required";
    manualPlacementAllowed: true;
    persisted: false;
  }
  interface SecuTorrentPeerSnapshot {
    capturedAt: string;
    localLocation: SecuTorrentLocalLocation;
    geoProvider: { offline: true; available: boolean; name: string };
    peers: SecuTorrentPeerSnapshotItem[];
    counts: { observed: number; active: number; returned: number; filtered: number };
    truncated: boolean;
  }
  type SecuTorrentLocatedSelf = {
    status: "available";
    source: "windows-location-service";
    local: true;
    approximate: true;
    latitude: number;
    longitude: number;
    accuracyMeters: number | null;
    capturedAt: string;
    persisted: false;
  } | {
    status: "unavailable";
    source: "windows-location-service";
    local: true;
    approximate: true;
    reason: "unsupported" | "disabled-or-denied" | "timeout" | "invalid-response";
    manualPlacementAllowed: true;
    capturedAt: string;
    persisted: false;
  };
  interface SecuTorrentTorrent {
    id: number;
    hash: string;
    name: string;
    status: string;
    percentDone: number;
    metadataPercentComplete: number;
    rateDownload: number;
    rateUpload: number;
    eta: number;
    uploadRatio: number;
    uploadedEver: number;
    downloadedEver: number;
    secondsSeeding: number;
    sizeWhenDone: number;
    peersConnected: number;
    peersGettingFromUs: number;
    peersSendingToUs: number;
    errorString: string;
    isPrivate: boolean;
    uploadLimited: boolean;
    uploadLimitKbps: number;
    seedRatioMode: number;
    seedRatioLimit: number;
    seedIdleMode: number;
    seedIdleLimit: number;
    bandwidthPriority: -1 | 0 | 1;
    peerLimit: number;
    honorsSessionLimits: boolean;
    isStalled: boolean;
    queuePosition: number;
    sharingBlocked: boolean;
    globalOverrideApplied: boolean;
    trackerSummary: Array<{ host: string; lastAnnounceSucceeded: boolean; lastAnnounceResult: string; seeders: number; leechers: number }>;
    peers: SecuTorrentPeer[];
    files: SecuTorrentFile[];
  }
  type SecuTorrentShareMode = "individual" | "share-all" | "stop-all";
  interface SecuTorrentGlobalSharing {
    schemaVersion: 2;
    enabled: boolean;
    shareMode: SecuTorrentShareMode;
    ratioLimit: number | null;
    idleMinutes: number | null;
    uploadLimitKbps: number | null;
    portMapping: boolean;
    /** Priorité strictement locale : elle n'impose aucune sélection aux pairs distants. */
    priorityMode: boolean;
  }
  interface SecuTorrentGlobalSharingEffective {
    bandwidthPriority: -1 | 0 | 1;
    uploadSlotsPerTorrent: number;
    targetUploadSlotsPerTorrent: number;
    seedQueueEnabled: boolean;
  }
  interface SecuTorrentGlobalSharingResult {
    ok: true;
    policy: SecuTorrentGlobalSharing;
    restartRequired: boolean;
    effective: SecuTorrentGlobalSharingEffective;
  }
  type SecuTorrentSharingVerdict = "healthy" | "ready-awaiting-peers" | "reachable-no-demand" | "closed" | "tracker-error" | "peers-choked" | "seed-peers-only" | "peers-not-interested" | "locally-choked" | "awaiting-requests" | "policy-stopped" | "security-blocked" | "degraded";
  interface SecuTorrentPeerFlow {
    connected: number;
    complete: number;
    incomplete: number;
    interested: number;
    unchokedInterested: number;
    uploading: number;
    incoming: number;
    utp: number;
    tcp: number;
    encrypted: number;
    /** Octets envoyés aux connexions présentes dans la fenêtre statistique récente du moteur. */
    bytesToPeers: number;
    rateToPeers: number;
  }
  interface SecuTorrentSharingPerformance {
    bandwidthPriority: -1 | 0 | 1;
    uploadSlotsPerTorrent: number;
    seedQueueEnabled: boolean;
    highPriorityTorrents: number;
    activeSeedTorrents: number;
    connectedPeers: number;
    activeUploadPeers: number;
    completePeers: number;
    incompletePeers: number;
    interestedPeers: number;
    locallyChokedPeers: number;
    unchokedInterestedPeers: number;
    uploadRate: number;
    uploadedEver: number;
    priorityMode: boolean;
    peerLimitGlobal: number;
    peerLimitPerTorrent: number;
    uploadLimitKbps: number | null;
    encryption: string;
    transports: string[];
  }
  interface SecuTorrentSharingDiagnostics {
    capturedAt: string;
    policy: SecuTorrentGlobalSharing;
    /** Verdict de bout en bout. Il ne prétend jamais garantir la sélection par un pair distant. */
    verdict: SecuTorrentSharingVerdict;
    performance: SecuTorrentSharingPerformance;
    port: { peerPort: number; reachable: boolean | null; mappingEnabled: boolean; protocol: string; error: string | null };
    totals: { rateUpload: number; uploadedBytes: number; activeTorrents: number };
    torrents: Array<{
      id: number; name: string; status: string; percentDone: number; rateUpload: number; uploadedEver: number; downloadedEver: number;
      uploadRatio: number; secondsSeeding: number; peersConnected: number; peersGettingFromUs: number; peersSendingToUs: number; isPrivate: boolean;
      bandwidthPriority: -1 | 0 | 1; peerLimit: number; honorsSessionLimits: boolean; isStalled: boolean; queuePosition: number; sharingBlocked: boolean;
      peerFlow: SecuTorrentPeerFlow;
      trackers: Array<{ host: string; announceState: number; hasAnnounced: boolean; lastAnnounceSucceeded: boolean; lastAnnounceTimedOut: boolean; lastAnnounceResult: string; lastAnnounceTime: number; nextAnnounceTime: number; seeders: number; leechers: number; downloads: number; downloaders: number; lastAnnouncePeerCount: number }>;
    }>;
  }
  interface SecuTorrentSharingHistory {
    schemaVersion: 1;
    windowHours: number;
    from: string | null;
    to: string | null;
    sampleCount: number;
    observedSeconds: number;
    uploadedBytes: number;
    peakUploadRate: number;
    uploadActiveSeconds: number;
    connectedSeconds: number;
    peerDemandSeconds: number;
    trackerDemandSeconds: number;
    maxConnectedPeers: number;
    maxInterestedPeers: number;
    maxServedPeers: number;
    maxIncomingPeers: number;
    maxUtpPeers: number;
    maxTcpPeers: number;
    maxEncryptedPeers: number;
    maxTrackerPeerCandidates: number;
    byTorrent: Array<{ id: number; uploadedBytes: number }>;
  }
  interface SecuTorrentStatus {
    ready: boolean;
    state: "ready" | "starting" | "stopped";
    running: boolean;
    rpcReady: boolean;
    version: string | null;
    rpcVersion: string | null;
    quarantineDir: string;
    downloadDir: string;
    incompleteDir: string;
    peerPort: number;
    portMapping: boolean;
    priorityMode: boolean;
    uploadSlotsPerTorrent: number;
  }
  interface SecuTorrentAuditEntry {
    v: number;
    seq: number;
    ts: string;
    event: string;
    actor: string;
    details: Record<string, unknown>;
    prevHash: string;
    hash: string;
  }
  interface Window {
    secuTorrent?: Readonly<{
      status(): Promise<SecuTorrentStatus>;
      list(): Promise<SecuTorrentTorrent[]>;
      globalSharing(): Promise<SecuTorrentGlobalSharing>;
      setGlobalSharing(options: SecuTorrentGlobalSharing): Promise<SecuTorrentGlobalSharingResult>;
      sharingDiagnostics(): Promise<SecuTorrentSharingDiagnostics>;
      sharingHistory(hours?: number): Promise<SecuTorrentSharingHistory>;
      peerSnapshot(): Promise<SecuTorrentPeerSnapshot>;
      locateSelf(): Promise<SecuTorrentLocatedSelf>;
      inspectMagnet(magnet: string): Promise<{ valid: boolean; verdict: "clean" | "review" | "blocked"; score: number; name: string; hash: string | null; trackers: string[]; issues: string[]; warnings: string[] }>;
      addMagnet(options: { magnet: string; rightsConfirmed: true; startPaused: true; destinationToken?: string; createSubfolder: boolean }): Promise<{ ok: true; torrent: SecuTorrentTorrent }>;
      importTorrent(options: { rightsConfirmed: true; startPaused: true; destinationToken?: string; createSubfolder: boolean; pendingToken?: string }): Promise<{ ok: boolean; canceled?: boolean; torrent?: SecuTorrentTorrent }>;
      pendingTorrentImports(): Promise<{ token: string; name: string; size: number }[]>;
      dismissTorrentImport(token: string): Promise<{ ok: true }>;
      onPendingTorrentImports(callback: () => void): () => void;
      chooseTorrentDestination(): Promise<{ ok: boolean; canceled?: boolean; token?: string; directory?: string }>;
      chooseDownloadDirectory(): Promise<{ ok: boolean; canceled?: boolean; changed?: boolean; directory?: string; appliesTo?: "new-torrents" }>;
      openDownloadDirectory(): Promise<{ ok: true }>;
      openTorrentDirectory(id: number): Promise<{ ok: true }>;
      start(id: number): Promise<{ ok: true; torrent: SecuTorrentTorrent }>;
      stop(id: number): Promise<{ ok: true; torrent: SecuTorrentTorrent }>;
      verifyAndScan(id: number): Promise<{ ok: true; clean: true; resumed: boolean; filesScanned: number; signatureUpdatedAt: string; torrent: SecuTorrentTorrent }>;
      remove(options: { id: number; deleteData: boolean }): Promise<{ ok: true }>;
      setSeedPolicy(options: { id: number; ratioLimit: number | null; idleMinutes: number | null; uploadLimitKbps: number | null }): Promise<{ ok: true; torrent: SecuTorrentTorrent }>;
      openMedia(options: { id: number; fileIndex: number; purpose?: "playback" | "thumbnail"; requestId?: string }): Promise<{ url: string; expiresAt: string; mimeType: string; name: string; audioAdapted: boolean; audioCodec: string | null; audioLanguage: string | null }>;
      renewMedia(url: string): Promise<{ expiresAt: string }>;
      releaseMedia(url: string): Promise<{ ok: true }>;
      cancelMediaPreparation(requestId: string): Promise<{ ok: true }>;
      watchHistory(): Promise<SecuTorrentWatchHistory>;
      savePlayback(options: { id: number; fileIndex: number; position: number; duration: number; completed: boolean }): Promise<SecuTorrentWatchRecord & { key: string }>;
      setMediaWatched(options: { id: number; fileIndex: number; watched: boolean }): Promise<SecuTorrentWatchRecord & { key: string }>;
      audit(limit?: number): Promise<SecuTorrentAuditEntry[]>;
    }>;
  }
}
