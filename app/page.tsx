"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity, AlertTriangle, ArrowDown, ArrowUp, BadgeCheck, Check, CheckCircle2,
  ChevronRight, FileInput, FolderLock, FolderOpen, Gauge, HardDrive, History,
  Globe2, Info, LayoutDashboard, Library, Link2, ListChecks, LoaderCircle, LockKeyhole,
  MapPin,
  Network, Pause, Play, Plus, Power, RadioTower, RefreshCw, ScanSearch, Search, Share2,
  ShieldAlert, ShieldCheck, ShieldQuestion, SlidersHorizontal, Trash2, UploadCloud,
  X,
} from "lucide-react";
import { MediaLibraryView } from "./components/MediaLibrary";
import { StrategicPeerMap, type StrategicLocalNode } from "./components/StrategicPeerMap";
import { inspectMagnet, type AnalysisResult } from "../lib/magnet";

type View = "dashboard" | "add" | "transfers" | "library" | "map" | "security" | "audit";
type Notice = { tone: "success" | "error" | "info"; message: string };
type EngineInspection = Awaited<ReturnType<NonNullable<Window["secuTorrent"]>["inspectMagnet"]>>;
type UiDaemon = Omit<Partial<SecuTorrentStatus>, "state"> & { ready: boolean; state: string; error?: string };
type UiAuditEntry = Partial<SecuTorrentAuditEntry> & {
  id?: string | number; timestamp?: string | number; action?: string; outcome?: string; level?: string;
  torrentName?: string; resource?: string; detail?: string;
};
type TorrentDestination = { token: string | null; directory: string | null; createSubfolder: boolean };
type DestinationResult = { ok: boolean; canceled?: boolean; token?: string; directory?: string };
type UiBridge = Omit<NonNullable<Window["secuTorrent"]>, "addMagnet" | "importTorrent"> & {
  chooseTorrentDestination(): Promise<DestinationResult>;
  addMagnet(options: { magnet: string; rightsConfirmed: true; startPaused: true; destinationToken?: string; createSubfolder: boolean }): ReturnType<NonNullable<Window["secuTorrent"]>["addMagnet"]>;
  importTorrent(options: { rightsConfirmed: true; startPaused: true; destinationToken?: string; createSubfolder: boolean; pendingToken?: string }): ReturnType<NonNullable<Window["secuTorrent"]>["importTorrent"]>;
};

const DEFAULT_TORRENT_DESTINATION: TorrentDestination = { token: null, directory: null, createSubfolder: true };

const navItems: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: "dashboard", label: "Vue d’ensemble", icon: LayoutDashboard },
  { id: "add", label: "Ajouter", icon: Plus },
  { id: "transfers", label: "Transferts", icon: Network },
  { id: "library", label: "Médiathèque", icon: Library },
  { id: "map", label: "Carte P2P", icon: Globe2 },
  { id: "security", label: "Protection", icon: ShieldCheck },
  { id: "audit", label: "Journal", icon: History },
];

const numberFormat = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const ratioFormatSmall = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const ratioFormatTiny = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "medium" });

function formatBytes(value?: number) {
  if (!Number.isFinite(value) || !value || value < 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) { current /= 1024; unit += 1; }
  return `${numberFormat.format(current)} ${units[unit]}`;
}

function formatRate(value?: number) { return value && value > 0 ? `${formatBytes(value)}/s` : "—"; }

function formatRatio(value?: number) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio <= 0) return "0";
  if (ratio < .0001) return "< 0,0001";
  if (ratio < .01) return ratioFormatTiny.format(ratio);
  if (ratio < .1) return ratioFormatSmall.format(ratio);
  return numberFormat.format(ratio);
}

function formatDuration(seconds?: number) {
  if (!Number.isFinite(seconds) || seconds === undefined || seconds < 0 || seconds > 31_536_000) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 86400)} j ${Math.floor((seconds % 86400) / 3600)} h`;
}

function statusCopy(status: string, progress: number) {
  const value = String(status ?? "").toLowerCase();
  if (value.includes("check") || value.includes("verif")) return "Vérification";
  if (value.includes("seed") || (progress >= .999 && value.includes("upload"))) return "Partage";
  if (value.includes("download")) return "Téléchargement";
  if (value.includes("queue") || value.includes("wait")) return "En attente";
  if (value.includes("stop") || value.includes("pause") || value === "0") return "En pause";
  if (value.includes("error")) return "Erreur";
  return status || "État inconnu";
}

function isRunning(torrent: SecuTorrentTorrent) {
  const status = String(torrent.status).toLowerCase();
  return !status.includes("stop") && !status.includes("pause") && status !== "0";
}

function scanTone(status?: string) {
  const value = String(status ?? "").toLowerCase();
  if (["clean", "safe", "passed", "verified"].some((item) => value.includes(item))) return "clean";
  if (["infect", "threat", "blocked", "quarantine", "malware"].some((item) => value.includes(item))) return "danger";
  return "pending";
}

function readableError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Échec local. Détails dans le journal.";
}

function getBridge(): UiBridge {
  if (typeof window === "undefined" || !window.secuTorrent) throw new Error("Interface locale indisponible. Ouvrez Slyorrent.");
  return window.secuTorrent as unknown as UiBridge;
}

function normalizeStatus(raw: SecuTorrentStatus): UiDaemon {
  const ready = raw.ready ?? Boolean(raw.running && raw.rpcReady);
  return { ...raw, ready, state: raw.state ?? (ready ? "Moteur prêt" : raw.running ? "RPC indisponible" : "Moteur arrêté") };
}

function DestinationControl({ id, destination, defaultDirectory, busy, disabled, onChoose, onSubfolderChange }: {
  id: string;
  destination: TorrentDestination;
  defaultDirectory?: string;
  busy: boolean;
  disabled: boolean;
  onChoose: () => void;
  onSubfolderChange: (checked: boolean) => void;
}) {
  const directory = destination.directory || defaultDirectory || "Dossier local géré par Slyorrent";
  return <section className="torrent-destination" aria-labelledby={`${id}-destination-title`}>
    <div className="torrent-destination-main">
      <span className="torrent-destination-icon"><FolderOpen size={16} /></span>
      <span className="torrent-destination-copy">
        <span id={`${id}-destination-title`}>Destination <em>{destination.token ? "CHOISIE" : "PAR DÉFAUT"}</em></span>
        <strong title={directory}>{directory}</strong>
      </span>
      <button className="secondary-button" type="button" disabled={disabled} onClick={onChoose}>
        {busy ? <LoaderCircle className="spin" size={14} /> : <FolderOpen size={14} />} Choisir
      </button>
    </div>
    <label className="torrent-subfolder" htmlFor={`${id}-create-subfolder`}>
      <input id={`${id}-create-subfolder`} type="checkbox" checked={destination.createSubfolder} disabled={disabled} onChange={(event) => onSubfolderChange(event.target.checked)} />
      <span>Créer un sous-dossier au nom du torrent</span>
    </label>
  </section>;
}

const DEFAULT_GLOBAL_SHARING: SecuTorrentGlobalSharing = {
  schemaVersion: 2,
  enabled: true,
  shareMode: "share-all",
  ratioLimit: null,
  idleMinutes: null,
  uploadLimitKbps: null,
  portMapping: false,
  priorityMode: true,
};

function effectiveSharingVerdict(diagnostics: SecuTorrentSharingDiagnostics): SecuTorrentSharingVerdict {
  if (diagnostics.verdict) return diagnostics.verdict;
  const torrents = diagnostics.torrents || [];
  const trackers = torrents.flatMap((torrent) => torrent.trackers || []);
  const successfulTrackers = trackers.filter((tracker) => tracker.lastAnnounceSucceeded).length;
  const activeUploadPeers = torrents.reduce((total, torrent) => total + Math.max(0, torrent.peersGettingFromUs || 0), 0);
  const connectedPeers = torrents.reduce((total, torrent) => total + Math.max(0, torrent.peersConnected || 0), 0);
  const uploadRate = torrents.reduce((total, torrent) => total + Math.max(0, torrent.rateUpload || 0), 0);
  if (diagnostics.policy.enabled && diagnostics.policy.shareMode === "stop-all") return "policy-stopped";
  if (activeUploadPeers > 0 || uploadRate > 0) return "healthy";
  if (trackers.length > 0 && successfulTrackers === 0) return "tracker-error";
  if (diagnostics.port.reachable === false) return "closed";
  if (connectedPeers > 0) return "peers-choked";
  if (diagnostics.port.reachable === true && successfulTrackers > 0) return "reachable-no-demand";
  return "degraded";
}

function sharingVerdictCopy(verdict: SecuTorrentSharingVerdict) {
  const copies: Record<SecuTorrentSharingVerdict, { tone: "success" | "error" | "info"; light: "ok" | "bad" | "warn"; title: string; detail: string }> = {
    healthy: { tone: "success", light: "ok", title: "Envoi actif", detail: "Au moins un pair reçoit des données." },
    "ready-awaiting-peers": { tone: "info", light: "warn", title: "Demande annoncée", detail: "Leechers annoncés ; sélection de source en attente." },
    "reachable-no-demand": { tone: "info", light: "warn", title: "Aucune demande", detail: "Port ouvert ; aucun bloc demandé." },
    closed: { tone: "error", light: "bad", title: "Port entrant fermé", detail: "Connexions sortantes disponibles ; entrantes indisponibles." },
    "tracker-error": { tone: "error", light: "bad", title: "Erreur tracker", detail: "Aucune annonce confirmée." },
    "peers-choked": { tone: "info", light: "warn", title: "Pairs connectés, aucun envoi", detail: "Aucun bloc demandé ou aucune source sélectionnée." },
    "seed-peers-only": { tone: "info", light: "warn", title: "Pairs déjà complets", detail: "Tous les pairs connectés possèdent 100 % des données." },
    "peers-not-interested": { tone: "info", light: "warn", title: "Aucune demande de blocs", detail: "Pairs incomplets connectés, sans requête active." },
    "locally-choked": { tone: "error", light: "bad", title: "Demandes en attente", detail: "Pairs intéressés, mais aucun créneau d’envoi attribué." },
    "awaiting-requests": { tone: "info", light: "warn", title: "Créneau ouvert", detail: "Pair autorisé, sans requête de bloc active." },
    "policy-stopped": { tone: "info", light: "warn", title: "Partage global arrêté", detail: "Tous les transferts sont suspendus." },
    "security-blocked": { tone: "error", light: "bad", title: "Partage bloqué", detail: "Nouvelle analyse antivirus requise." },
    degraded: { tone: "info", light: "warn", title: "Diagnostic incomplet", detail: "Données insuffisantes." },
  };
  return copies[verdict];
}

function effectiveSharingPerformance(diagnostics: SecuTorrentSharingDiagnostics, daemon: UiDaemon): SecuTorrentSharingPerformance {
  if (diagnostics.performance) return diagnostics.performance;
  const torrents = diagnostics.torrents || [];
  const priorityEnabled = diagnostics.policy.enabled && diagnostics.policy.priorityMode;
  return {
    priorityMode: priorityEnabled,
    bandwidthPriority: priorityEnabled ? 1 : 0,
    uploadSlotsPerTorrent: Number(daemon.uploadSlotsPerTorrent ?? (priorityEnabled ? 4 : 8)),
    seedQueueEnabled: !priorityEnabled,
    highPriorityTorrents: priorityEnabled ? torrents.filter((torrent) => torrent.percentDone >= .999999).length : 0,
    activeSeedTorrents: torrents.filter((torrent) => torrent.percentDone >= .999999 && !String(torrent.status).includes("stopped")).length,
    connectedPeers: torrents.reduce((total, torrent) => total + Math.max(0, torrent.peersConnected || 0), 0),
    activeUploadPeers: torrents.reduce((total, torrent) => total + Math.max(0, torrent.peersGettingFromUs || 0), 0),
    completePeers: 0,
    incompletePeers: 0,
    interestedPeers: 0,
    locallyChokedPeers: 0,
    unchokedInterestedPeers: 0,
    uploadRate: torrents.reduce((total, torrent) => total + Math.max(0, torrent.rateUpload || 0), 0),
    uploadedEver: torrents.reduce((total, torrent) => total + Math.max(0, torrent.uploadedEver || 0), 0),
    peerLimitGlobal: 0,
    peerLimitPerTorrent: 0,
    uploadLimitKbps: diagnostics.policy.uploadLimitKbps,
    encryption: "unknown",
    transports: [],
  };
}

export default function Home() {
  const [activeView, setActiveView] = useState<View>("dashboard");
  const [daemon, setDaemon] = useState<UiDaemon>({ ready: false, state: "Connexion…" });
  const [torrents, setTorrents] = useState<SecuTorrentTorrent[]>([]);
  const [auditEntries, setAuditEntries] = useState<UiAuditEntry[]>([]);
  const [peerSnapshot, setPeerSnapshot] = useState<SecuTorrentPeerSnapshot | null>(null);
  const peerSnapshotInFlight = useRef(false);
  const [mapError, setMapError] = useState("");
  const [localNode, setLocalNode] = useState<StrategicLocalNode | null>(null);
  const [locating, setLocating] = useState(false);
  const [manualPlacementOpen, setManualPlacementOpen] = useState(false);
  const [manualPlacement, setManualPlacement] = useState({ latitude: "", longitude: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [query, setQuery] = useState("");
  const [magnet, setMagnet] = useState("");
  const [magnetError, setMagnetError] = useState("");
  const [inspection, setInspection] = useState<AnalysisResult | null>(null);
  const [engineInspection, setEngineInspection] = useState<EngineInspection | null>(null);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [externalImport, setExternalImport] = useState<{ token: string; name: string; size: number } | null>(null);
  const [importRights, setImportRights] = useState(false);
  const [magnetDestination, setMagnetDestination] = useState<TorrentDestination>(DEFAULT_TORRENT_DESTINATION);
  const [importDestination, setImportDestination] = useState<TorrentDestination>(DEFAULT_TORRENT_DESTINATION);
  const [policyTarget, setPolicyTarget] = useState<SecuTorrentTorrent | null>(null);
  const [policy, setPolicy] = useState({ ratioLimit: 2, idleMinutes: 30, uploadLimitKbps: 1024 });
  const [globalPolicyOpen, setGlobalPolicyOpen] = useState(false);
  const [globalSharing, setGlobalSharing] = useState<SecuTorrentGlobalSharing>(DEFAULT_GLOBAL_SHARING);
  const [sharingApplyResult, setSharingApplyResult] = useState<SecuTorrentGlobalSharingResult | null>(null);
  const [sharingDiagnostics, setSharingDiagnostics] = useState<SecuTorrentSharingDiagnostics | null>(null);
  const [sharingHistory, setSharingHistory] = useState<SecuTorrentSharingHistory | null>(null);
  const diagnosticsVisible = activeView === "transfers" && sharingDiagnostics !== null;
  const searchRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const notify = useCallback((tone: Notice["tone"], message: string) => setNotice({ tone, message }), []);
  const closeImport = useCallback(async () => {
    if (externalImport) {
      try { await getBridge().dismissTorrentImport(externalImport.token); }
      catch (error) { notify("error", readableError(error)); return; }
    }
    setImportOpen(false); setExternalImport(null); setImportRights(false);
    setImportDestination({ ...DEFAULT_TORRENT_DESTINATION });
  }, [externalImport, notify]);

  useEffect(() => {
    let disposed = false;
    const api = window.secuTorrent;
    if (!api?.pendingTorrentImports || !api.onPendingTorrentImports) return;
    const refreshPending = async () => {
      try {
        const pending = await api.pendingTorrentImports();
        if (disposed || importOpen || externalImport || busy || policyTarget || globalPolicyOpen || !pending.length) return;
        setExternalImport(pending[0]); setImportOpen(true); setImportRights(false);
        setImportDestination({ ...DEFAULT_TORRENT_DESTINATION }); setActiveView("add");
      } catch { /* Le prochain événement ou remontage relira la file locale. */ }
    };
    const unsubscribe = api.onPendingTorrentImports(() => void refreshPending());
    void refreshPending();
    return () => { disposed = true; unsubscribe(); };
  }, [importOpen, externalImport, busy, policyTarget, globalPolicyOpen]);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const api = getBridge();
      const [nextDaemon, nextTorrents, nextGlobalSharing] = await Promise.all([api.status(), api.list(), api.globalSharing()]);
      setDaemon(normalizeStatus(nextDaemon));
      setTorrents(Array.isArray(nextTorrents) ? nextTorrents : []);
      setGlobalSharing(nextGlobalSharing);
    } catch (error) {
      setDaemon({ ready: false, state: "Moteur indisponible", error: readableError(error) });
      if (!silent) notify("error", readableError(error));
    } finally { if (!silent) setLoading(false); }
  }, [notify]);

  const loadAudit = useCallback(async () => {
    try {
      const entries = await getBridge().audit(250);
      setAuditEntries(Array.isArray(entries) ? entries : []);
    } catch (error) { notify("error", readableError(error)); }
  }, [notify]);

  useEffect(() => {
    const kickoff = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(true); }, 2500);
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(true); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearTimeout(kickoff); window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisibility); };
  }, [refresh]);

  useEffect(() => {
    if (activeView !== "audit") return;
    const kickoff = window.setTimeout(() => void loadAudit(), 0);
    return () => window.clearTimeout(kickoff);
  }, [activeView, loadAudit]);

  const refreshPeerSnapshot = useCallback(async () => {
    if (peerSnapshotInFlight.current) return;
    peerSnapshotInFlight.current = true;
    try {
      const nextSnapshot = await getBridge().peerSnapshot();
      setPeerSnapshot(nextSnapshot);
      setMapError("");
    } catch (error) {
      setMapError(readableError(error));
    } finally {
      peerSnapshotInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (activeView !== "map") return;
    const kickoff = window.setTimeout(() => void refreshPeerSnapshot(), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshPeerSnapshot();
    }, 1_200);
    return () => { window.clearTimeout(kickoff); window.clearInterval(interval); };
  }, [activeView, refreshPeerSnapshot]);

  useEffect(() => {
    if (!diagnosticsVisible) return;
    let disposed = false;
    let inFlight = false;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible" || inFlight) return;
      inFlight = true;
      void getBridge().sharingDiagnostics()
        .then((result) => { if (!disposed) setSharingDiagnostics(result); })
        .catch(() => undefined)
        .finally(() => { inFlight = false; });
    }, 2_500);
    return () => { disposed = true; window.clearInterval(interval); };
  }, [diagnosticsVisible]);

  useEffect(() => {
    if (!diagnosticsVisible) return;
    const refreshHistory = () => void getBridge().sharingHistory(12).then(setSharingHistory).catch(() => undefined);
    const kickoff = window.setTimeout(refreshHistory, 0);
    const interval = window.setInterval(refreshHistory, 60_000);
    return () => { window.clearTimeout(kickoff); window.clearInterval(interval); };
  }, [diagnosticsVisible]);

  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 5000); return () => window.clearTimeout(timer); }, [notice]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === "Escape") {
        if (importOpen && busy !== "import") void closeImport();
        setPolicyTarget(null); setGlobalPolicyOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [importOpen, busy, closeImport]);

  const modalOpen = importOpen || Boolean(policyTarget) || globalPolicyOpen;
  useEffect(() => {
    if (!modalOpen) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const background = Array.from(document.querySelectorAll<HTMLElement>(".sidebar, .workspace"));
    background.forEach((element) => { element.setAttribute("inert", ""); element.setAttribute("aria-hidden", "true"); });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = document.querySelector<HTMLElement>("[role='dialog']");
    const frame = window.requestAnimationFrame(() => dialog?.querySelector<HTMLElement>("button, input, textarea, [tabindex]:not([tabindex='-1'])")?.focus());
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), video[controls], [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(frame); window.removeEventListener("keydown", trapFocus);
      background.forEach((element) => { element.removeAttribute("inert"); element.removeAttribute("aria-hidden"); });
      document.body.style.overflow = previousOverflow; previousFocus.current?.focus();
    };
  }, [modalOpen]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("fr");
    return needle ? torrents.filter((torrent) => `${torrent.name} ${torrent.hash} ${torrent.status}`.toLocaleLowerCase("fr").includes(needle)) : torrents;
  }, [query, torrents]);

  const stats = useMemo(() => ({
    active: torrents.filter(isRunning).length,
    rateDownload: torrents.reduce((total, torrent) => total + Math.max(0, torrent.rateDownload || 0), 0),
    rateUpload: torrents.reduce((total, torrent) => total + Math.max(0, torrent.rateUpload || 0), 0),
    uploaded: torrents.reduce((total, torrent) => total + Math.max(0, torrent.uploadedEver || 0), 0),
    warnings: torrents.filter((torrent) => Boolean(torrent.errorString) || torrent.files?.some((file) => scanTone(file.scanStatus) === "danger")).length,
  }), [torrents]);
  const diagnosticVerdict = sharingDiagnostics ? effectiveSharingVerdict(sharingDiagnostics) : null;
  const diagnosticCopy = diagnosticVerdict ? sharingVerdictCopy(diagnosticVerdict) : null;
  const diagnosticPerformance = sharingDiagnostics ? effectiveSharingPerformance(sharingDiagnostics, daemon) : null;

  async function runAction(key: string, action: () => Promise<unknown>, success: string) {
    setBusy(key);
    try { await action(); notify("success", success); await refresh(true); if (activeView === "audit") await loadAudit(); return true; }
    catch (error) { notify("error", readableError(error)); return false; }
    finally { setBusy(null); }
  }

  function resetMagnetDestination() { setMagnetDestination({ ...DEFAULT_TORRENT_DESTINATION }); }
  function resetImportDestination() { setImportDestination({ ...DEFAULT_TORRENT_DESTINATION }); }

  async function chooseDestination(target: "magnet" | "import") {
    const busyKey = `destination-${target}`;
    setBusy(busyKey);
    try {
      const result = await getBridge().chooseTorrentDestination();
      if (!result?.ok || result.canceled) {
        if (target === "magnet") resetMagnetDestination(); else resetImportDestination();
        return;
      }
      if (typeof result.token !== "string" || !result.token || typeof result.directory !== "string" || !result.directory) {
        throw new Error("Destination locale invalide.");
      }
      const update = (current: TorrentDestination): TorrentDestination => ({ ...current, token: result.token!, directory: result.directory! });
      if (target === "magnet") setMagnetDestination(update); else setImportDestination(update);
    } catch (error) {
      notify("error", readableError(error));
    } finally {
      setBusy(null);
    }
  }

  async function analyzeMagnet(event: FormEvent) {
    event.preventDefault(); setEngineInspection(null);
    const local = inspectMagnet(magnet);
    if (!local.result || local.error) { setInspection(null); setMagnetError(local.error ?? "Lien magnet invalide."); return; }
    setInspection(local.result); setMagnetError(""); setRightsConfirmed(false);
    if (local.result.verdict === "blocked") return;
    setBusy("inspect");
    try {
      const result = await getBridge().inspectMagnet(magnet.trim());
      if (!result?.valid) throw new Error(result?.issues?.[0] || "Magnet refusé par le moteur local.");
      setEngineInspection(result);
    }
    catch (error) { setMagnetError(`Refus du moteur : ${readableError(error)}`); }
    finally { setBusy(null); }
  }

  async function addMagnetPaused() {
    if (!inspection || inspection.verdict === "blocked" || !rightsConfirmed || !engineInspection) return;
    const added = await runAction("add-magnet", () => getBridge().addMagnet({
      magnet: magnet.trim(), rightsConfirmed: true, startPaused: true,
      ...(magnetDestination.token ? { destinationToken: magnetDestination.token } : {}),
      createSubfolder: magnetDestination.createSubfolder,
    }), "Torrent ajouté en pause.");
    if (!added) return;
    setMagnet(""); setInspection(null); setEngineInspection(null); setRightsConfirmed(false); setActiveView("transfers");
    resetMagnetDestination();
  }

  async function importTorrent() {
    if (!importRights) return;
    setBusy("import");
    try {
      const result = await getBridge().importTorrent({
        rightsConfirmed: true, startPaused: true,
        ...(externalImport ? { pendingToken: externalImport.token } : {}),
        ...(importDestination.token ? { destinationToken: importDestination.token } : {}),
        createSubfolder: importDestination.createSubfolder,
      });
      if (result && typeof result === "object" && "canceled" in result && result.canceled) notify("info", "Import annulé.");
      else { notify("success", "Fichier .torrent importé en pause."); setActiveView("transfers"); }
      await refresh(true);
    } catch (error) { notify("error", readableError(error)); }
    finally { await closeImport(); setBusy(null); }
  }

  async function requestMapLocation() {
    if (locating) return;
    setLocating(true);
    try {
      const result = await getBridge().locateSelf();
      if (result.status !== "available") {
        setManualPlacementOpen(true);
        notify("info", "Localisation Windows indisponible. Placement manuel disponible.");
        return;
      }
      setLocalNode({
        latitude: result.latitude,
        longitude: result.longitude,
        source: "windows-location-service",
        accuracyMeters: result.accuracyMeters,
        approximate: true,
      });
      setManualPlacementOpen(false);
      notify("success", "Position locale définie en mémoire.");
    } catch (error) {
      setManualPlacementOpen(true);
      notify("error", readableError(error));
    } finally {
      setLocating(false);
    }
  }

  function applyManualPlacement(event: FormEvent) {
    event.preventDefault();
    const latitude = Number(manualPlacement.latitude);
    const longitude = Number(manualPlacement.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      notify("error", "Latitude ou longitude invalide.");
      return;
    }
    setLocalNode({ latitude, longitude, source: "manual", approximate: true });
    setManualPlacementOpen(false);
    notify("success", "Position manuelle définie en mémoire.");
  }

  function openPolicy(torrent: SecuTorrentTorrent) { setPolicyTarget(torrent); setPolicy({ ratioLimit: 2, idleMinutes: 30, uploadLimitKbps: 1024 }); }

  async function savePolicy(event: FormEvent) {
    event.preventDefault(); if (!policyTarget) return;
    const ratio = Number(policy.ratioLimit); const idle = Math.round(Number(policy.idleMinutes)); const upload = Math.round(Number(policy.uploadLimitKbps));
    const safePolicy = { ratioLimit: ratio > 0 ? Math.min(100, Math.max(.1, ratio)) : null, idleMinutes: idle > 0 ? Math.min(10080, Math.max(1, idle)) : null, uploadLimitKbps: upload > 0 ? Math.min(1_000_000, Math.max(1, upload)) : null };
    await runAction(`policy-${policyTarget.id}`, () => getBridge().setSeedPolicy({ id: policyTarget.id, ...safePolicy }), "Politique enregistrée.");
    setPolicyTarget(null);
  }

  async function applyGlobalSharing(next: SecuTorrentGlobalSharing, success: string) {
    setBusy("global-sharing");
    try {
      const result = await getBridge().setGlobalSharing(next);
      setGlobalSharing(result.policy);
      setSharingApplyResult(result);
      setSharingDiagnostics(null);
      notify(
        result.restartRequired ? "info" : "success",
        result.restartRequired ? `${success} Redémarrage requis pour les créneaux d’envoi.` : success,
      );
      await refresh(true);
      if (activeView === "audit") await loadAudit();
    } catch (error) {
      notify("error", readableError(error));
    } finally {
      setBusy(null);
    }
  }

  async function saveGlobalPolicy(event: FormEvent) {
    event.preventDefault();
    const safePolicy: SecuTorrentGlobalSharing = {
      ...globalSharing,
      ratioLimit: globalSharing.ratioLimit && globalSharing.ratioLimit > 0 ? Math.min(100, Math.max(.1, globalSharing.ratioLimit)) : null,
      idleMinutes: globalSharing.idleMinutes && globalSharing.idleMinutes > 0 ? Math.min(10_080, Math.max(1, Math.round(globalSharing.idleMinutes))) : null,
      uploadLimitKbps: globalSharing.uploadLimitKbps && globalSharing.uploadLimitKbps > 0 ? Math.min(1_000_000, Math.max(1, Math.round(globalSharing.uploadLimitKbps))) : null,
    };
    await applyGlobalSharing(safePolicy, "Paramètres globaux appliqués.");
    setGlobalPolicyOpen(false);
  }

  async function diagnoseSharing() {
    setBusy("sharing-diagnostics");
    try {
      const [result, history] = await Promise.all([getBridge().sharingDiagnostics(), getBridge().sharingHistory(12)]);
      setSharingDiagnostics(result);
      setSharingHistory(history);
      const copy = sharingVerdictCopy(effectiveSharingVerdict(result));
      notify(copy.tone, `${copy.title} · ${copy.detail}`);
    } catch (error) { notify("error", readableError(error)); }
    finally { setBusy(null); }
  }

  const TransferRow = ({ torrent, compact = false }: { torrent: SecuTorrentTorrent; compact?: boolean }) => {
    const running = isRunning(torrent); const percent = Math.max(0, Math.min(100, (torrent.percentDone || 0) * 100));
    const hasThreat = torrent.sharingBlocked || torrent.files?.some((file) => scanTone(file.scanStatus) === "danger");
    const globallyMaintained = running && globalSharing.enabled && globalSharing.shareMode === "share-all";
    const tracker = torrent.trackerSummary?.[0];
    return <article className={`transfer-row ${compact ? "compact" : ""} ${hasThreat ? "threat" : ""}`}>
      <span className="file-icon"><HardDrive size={19} /></span>
      <div className="transfer-copy"><div><strong>{torrent.name || "Torrent sans nom"}</strong>{torrent.isPrivate && <span className="private-pill"><LockKeyhole size={11} /> privé</span>}{torrent.sharingBlocked && <span className="private-pill"><ShieldAlert size={10} /> partage bloqué</span>}{torrent.bandwidthPriority === 1 && !torrent.sharingBlocked && <span className="priority-pill" title="Priorité dans le moteur local"><Gauge size={10} /> priorité locale</span>}</div><small>{formatBytes(torrent.sizeWhenDone)} · ↑ {formatBytes(torrent.uploadedEver)} · ratio {formatRatio(torrent.uploadRatio)} · pairs {torrent.peersConnected ?? 0}</small>{tracker && <span className={`tracker-health ${tracker.lastAnnounceSucceeded ? "ok" : "bad"}`}><RadioTower size={11} /> {tracker.host} · {tracker.lastAnnounceSucceeded ? "annonce OK" : tracker.lastAnnounceResult || "annonce en attente"} · {Math.max(0, tracker.seeders)} seed · {Math.max(0, tracker.leechers)} leech</span>}{torrent.errorString && <span className="inline-error"><AlertTriangle size={12} /> {torrent.errorString}</span>}</div>
      <div className="transfer-state"><span className={`state-pill ${running ? "online" : "paused"}`}>{statusCopy(torrent.status, torrent.percentDone)}</span><small><ArrowDown size={11} /> {formatRate(torrent.rateDownload)} <ArrowUp size={11} /> {formatRate(torrent.rateUpload)}</small></div>
      <div className="progress-block"><div><strong>{numberFormat.format(percent)} %</strong><small>{percent >= 100 ? `${formatDuration(torrent.secondsSeeding)} en partage` : `reste ${formatDuration(torrent.eta)}`}</small></div><div className="progress-track" role="progressbar" aria-label={`Progression de ${torrent.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><i style={{ width: `${percent}%` }} /></div></div>
      <div className="row-actions">
        <button className="icon-button primary-icon" type="button" disabled={busy !== null || hasThreat || globallyMaintained} title={globallyMaintained ? "Contrôlé par le partage global" : undefined} onClick={() => void runAction(`${running ? "stop" : "start"}-${torrent.id}`, () => running ? getBridge().stop(torrent.id) : getBridge().start(torrent.id), running ? "Torrent en pause." : percent >= 100 ? "Partage démarré." : "Téléchargement démarré.")} aria-label={running ? `Mettre ${torrent.name} en pause` : `Démarrer ${torrent.name}`}>{busy === `${running ? "stop" : "start"}-${torrent.id}` ? <LoaderCircle className="spin" size={16} /> : running ? <Pause size={16} /> : <Play size={16} />}</button>
        {!compact && <><button className="icon-button" type="button" disabled={busy !== null || percent < 100} onClick={() => void runAction(`validate-${torrent.id}`, () => getBridge().verifyAndScan(torrent.id), "Vérification et analyse terminées.")} aria-label={`Vérifier et analyser ${torrent.name}`} title={percent < 100 ? "Torrent incomplet" : "Vérifier les pièces puis analyser avec Microsoft Defender"}>{busy === `validate-${torrent.id}` ? <LoaderCircle className="spin" size={15} /> : <ScanSearch size={15} />}</button><button className="icon-button" type="button" disabled={busy !== null || globalSharing.enabled} onClick={() => openPolicy(torrent)} aria-label={`Politique de partage de ${torrent.name}`} title={globalSharing.enabled ? "Paramètres globaux actifs" : "Politique de partage"}><SlidersHorizontal size={15} /></button><button className="icon-button danger" type="button" disabled={busy !== null} onClick={() => void runAction(`remove-${torrent.id}`, () => getBridge().remove({ id: torrent.id, deleteData: false }), "Torrent retiré. Données conservées.")} aria-label={`Retirer ${torrent.name} sans supprimer ses données`} title="Retirer sans supprimer les données"><Trash2 size={15} /></button></>}
      </div>
    </article>;
  };

  return <div className="secu-shell">
    <a className="skip-link" href="#main-content">Aller au contenu</a>
    <aside className="sidebar">
      <button className="brand" type="button" onClick={() => setActiveView("dashboard")} aria-label="Slyorrent, accueil"><span className="brand-mark"><img src="./slyorus.png" alt="" /></span><span><strong>Slyorrent</strong><small>Protection Slyorus</small></span></button>
      <nav aria-label="Navigation principale">{navItems.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" className={activeView === item.id ? "active" : ""} onClick={() => setActiveView(item.id)} aria-current={activeView === item.id ? "page" : undefined}><Icon size={18} /><span>{item.label}</span>{item.id === "security" && stats.warnings > 0 && <em>{stats.warnings}</em>}</button>; })}</nav>
      <div className={`daemon-card ${daemon.ready ? "ready" : "offline"}`}><span className="daemon-orb"><RadioTower size={18} /></span><div><strong>{daemon.ready ? "Moteur local prêt" : "Moteur hors ligne"}</strong><small>{daemon.version ? `Transmission ${daemon.version}` : daemon.state}</small></div><i /></div>
    </aside>

    <main className="workspace" id="main-content" tabIndex={-1}>
      <header className="topbar"><div className="mobile-brand"><img src="./slyorus.png" alt="" /><b>Slyorrent</b></div><label className="search-box"><Search size={16} /><span className="sr-only">Rechercher</span><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher…" /><kbd>Ctrl K</kbd></label><div className="top-status"><span className={daemon.ready ? "connected" : "disconnected"} /><div><b>{daemon.ready ? "Local" : "Hors ligne"}</b><small>{daemon.ready ? "Cloud désactivé" : "Moteur arrêté"}</small></div></div><button className="icon-button" type="button" disabled={loading} onClick={() => void refresh()} aria-label="Actualiser"><RefreshCw className={loading ? "spin" : ""} size={17} /></button></header>

      {!daemon.ready && <section className="offline-banner" role="alert"><ShieldAlert size={22} /><div><strong>Moteur P2P indisponible</strong><p>{daemon.error || "Transferts suspendus."}</p></div><button type="button" onClick={() => void refresh()}>Réessayer</button></section>}

      {activeView === "dashboard" && <>
        <section className="hero-panel"><div className="hero-grid" aria-hidden="true" /><div className="hero-copy"><span className="local-badge"><ShieldCheck size={14} /> EXÉCUTION LOCALE</span><h1>Client P2P<br /><em>local</em></h1><p>Téléchargement, partage, antivirus et journal. Contenus autorisés uniquement.</p><div className="hero-actions"><button className="primary-button" type="button" onClick={() => setActiveView("add")}><Link2 size={16} /> Ajouter un magnet</button><button className="secondary-button dark" type="button" onClick={() => setImportOpen(true)}><FileInput size={16} /> Importer un .torrent</button></div><div className="privacy-line"><LockKeyhole size={13} /> Moteur, journaux et médias sur cet appareil.</div></div><div className="mascot-stage"><div className="orbit one" /><div className="orbit two" /><img src="./slyorus.png" alt="Slyorus, chouette cybernétique blanche aux yeux bleus" /><span className="mascot-status"><i /><span><b>PROTECTION ACTIVE</b><small>Contrôles locaux</small></span></span></div></section>
        <section className="stats-grid" aria-label="Statistiques du moteur"><article><span className="stat-icon blue"><Activity size={18} /></span><div><strong>{stats.active}</strong><small>Actifs</small></div></article><article><span className="stat-icon cyan"><ArrowDown size={18} /></span><div><strong>{formatRate(stats.rateDownload)}</strong><small>Réception</small></div></article><article><span className="stat-icon orange"><ArrowUp size={18} /></span><div><strong>{formatRate(stats.rateUpload)}</strong><small>Envoi</small></div></article><article><span className="stat-icon navy"><UploadCloud size={18} /></span><div><strong>{formatBytes(stats.uploaded)}</strong><small>Total envoyé</small></div></article></section>
        <section className="dashboard-grid"><div className="panel transfers-panel"><header className="panel-title"><div><span className="eyebrow">TEMPS RÉEL</span><h2>Transferts récents</h2></div><button type="button" onClick={() => setActiveView("transfers")}>Tous <ChevronRight size={14} /></button></header>{filtered.slice(0, 3).length ? filtered.slice(0, 3).map((torrent) => <TransferRow key={torrent.id} torrent={torrent} compact />) : <EmptyState icon={Network} title="Aucun transfert" text="Les nouveaux torrents sont ajoutés en pause." />}</div><aside className="panel guard-panel"><span className="eyebrow">SÉCURITÉ</span><h2>Contrôles actifs</h2><ol><li className="done"><Check size={13} /><span><b>Interface isolée</b><small>Accès Node bloqué</small></span></li><li className="done"><Check size={13} /><span><b>Ajout en pause</b><small>Envoi bloqué avant validation</small></span></li><li><ScanSearch size={13} /><span><b>Pièces + antivirus</b><small>Lecture après validation</small></span></li><li><ListChecks size={13} /><span><b>Journal chaîné</b><small>Altérations détectables</small></span></li></ol><button className="secondary-button" type="button" onClick={() => setActiveView("security")}>Détails</button></aside></section>
      </>}

      {activeView === "add" && <>
        <ViewHeader eyebrow="AJOUT CONTRÔLÉ" title="Ajouter un torrent" text="Double validation locale. Démarrage en pause." icon={Link2} action={<button className="secondary-button" type="button" onClick={() => setImportOpen(true)}><FileInput size={16} /> Importer un .torrent</button>} />
        <section className="add-layout">
          <form className="panel magnet-form" onSubmit={(event) => void analyzeMagnet(event)} noValidate>
            <div className="step-label"><span>1</span><div><b>Contrôle du magnet</b><small>Aucune sauvegarde avant validation</small></div></div>
            <label htmlFor="magnet-input">Lien magnet</label>
            <div className={`magnet-input ${magnetError ? "invalid" : ""}`}>
              <Link2 size={18} />
              <textarea id="magnet-input" value={magnet} onChange={(event) => { setMagnet(event.target.value); setMagnetError(""); setInspection(null); setEngineInspection(null); setRightsConfirmed(false); }} placeholder="magnet:?xt=urn:btih:…" rows={5} maxLength={4096} aria-invalid={Boolean(magnetError)} aria-describedby={magnetError ? "magnet-error" : "magnet-help"} />
              <button className="primary-button" type="submit" disabled={!daemon.ready || busy === "inspect"}>{busy === "inspect" ? <LoaderCircle className="spin" size={16} /> : <ScanSearch size={16} />} Vérifier</button>
            </div>
            {magnetError ? <p className="form-error" id="magnet-error" role="alert"><AlertTriangle size={14} /> {magnetError}</p> : <p className="form-help" id="magnet-help"><LockKeyhole size={13} /> Aucun contact tracker ou pair depuis l’interface.</p>}
            <DestinationControl
              id="magnet"
              destination={magnetDestination}
              defaultDirectory={daemon.downloadDir}
              busy={busy === "destination-magnet"}
              disabled={busy !== null}
              onChoose={() => void chooseDestination("magnet")}
              onSubfolderChange={(checked) => setMagnetDestination((current) => ({ ...current, createSubfolder: checked }))}
            />
          </form>
          <aside className="panel add-rules"><span className="eyebrow">VALIDATION</span><h2>Contrôles appliqués</h2><ul><li><CheckCircle2 size={16} /><span><b>Infohash BTIH/BTMH</b><small>Format contrôlé</small></span></li><li><ShieldAlert size={16} /><span><b>URL et chemins</b><small>Sources à risque signalées</small></span></li><li><Pause size={16} /><span><b>Démarrage manuel</b><small>Import en pause</small></span></li><li><BadgeCheck size={16} /><span><b>Droits confirmés</b><small>Confirmation journalisée</small></span></li></ul></aside>
        </section>
        {inspection && <section className={`panel inspection-card ${inspection.verdict}`}><header><span className="verdict-icon">{inspection.verdict === "blocked" ? <ShieldAlert size={22} /> : inspection.verdict === "review" ? <ShieldQuestion size={22} /> : <ShieldCheck size={22} />}</span><div><span className="eyebrow">RÉSULTAT</span><h2>{inspection.verdict === "blocked" ? "Lien bloqué" : inspection.verdict === "review" ? "Examen requis" : "Structure conforme"}</h2><p>{inspection.name}</p></div><strong className="score">{inspection.score}<small>/100</small></strong></header><div className="inspection-grid"><div><small>Infohash</small><code>{inspection.hash}</code></div><div><small>Trackers</small><b>{inspection.trackers}</b></div><div><small>Moteur</small><b>{engineInspection ? "Accepté" : inspection.verdict === "blocked" ? "Non exécuté" : "En attente"}</b></div></div>{inspection.reasons.length > 0 && <div className="reason-box"><b>Points à vérifier</b>{inspection.reasons.map((reason) => <span key={reason}><AlertTriangle size={13} /> {reason}</span>)}</div>}{inspection.verdict !== "blocked" && engineInspection && <div className="rights-box"><label><input type="checkbox" checked={rightsConfirmed} onChange={(event) => setRightsConfirmed(event.target.checked)} /><span className="custom-check"><Check size={13} /></span><span><b>Droits de téléchargement et de partage confirmés</b><small>Confirmation locale limitée à ce contenu.</small></span></label><button className="primary-button" type="button" disabled={!rightsConfirmed || busy !== null} onClick={() => void addMagnetPaused()}>{busy === "add-magnet" ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} Ajouter en pause</button></div>}</section>}
      </>}

      {activeView === "transfers" && <>
        <ViewHeader eyebrow="MOTEUR P2P" title="Transferts" text="Débits, pairs, volumes et ratio du moteur local." icon={Network} action={<div className="header-actions"><button className="secondary-button" type="button" onClick={() => setImportOpen(true)}><FileInput size={15} /> Importer</button><button className="primary-button" type="button" onClick={() => setActiveView("add")}><Plus size={15} /> Magnet</button></div>} />
        <section className={`panel global-sharing-panel ${globalSharing.shareMode}`}>
          <div className="global-sharing-copy"><span className="eyebrow">PARTAGE GLOBAL</span><h2>Réglages d’envoi</h2><p>{globalSharing.enabled && globalSharing.priorityMode ? "Priorité active : transferts en cours, puis seeds avec demande tracker." : globalSharing.enabled ? "Limites globales actives · priorité standard." : "Politiques par torrent actives."} <strong>↑ {formatBytes(stats.uploaded)}</strong></p><div className="sharing-policy-badges"><span className={`priority-pill ${globalSharing.enabled && globalSharing.priorityMode ? "active" : ""}`}><Gauge size={10} /> priorité {globalSharing.enabled && globalSharing.priorityMode ? "active" : "standard"}</span>{sharingApplyResult?.restartRequired && <span className="restart-pill"><RefreshCw size={10} /> redémarrage requis</span>}</div></div>
          <div className="global-sharing-actions" role="group" aria-label="Mode global de partage">
            <button className={globalSharing.shareMode === "share-all" ? "primary-button" : "secondary-button"} type="button" disabled={busy !== null} onClick={() => void applyGlobalSharing({ ...globalSharing, enabled: true, shareMode: "share-all" }, "Partage global actif.")}><Share2 size={15} /> Partager tout</button>
            <button className={globalSharing.enabled && globalSharing.shareMode === "stop-all" ? "stop-all-button" : "secondary-button"} type="button" disabled={busy !== null} onClick={() => void applyGlobalSharing({ ...globalSharing, enabled: true, shareMode: "stop-all" }, "Transferts arrêtés.")}><Power size={15} /> Tout arrêter</button>
            <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => setGlobalPolicyOpen(true)}><SlidersHorizontal size={15} /> Paramètres</button>
            <button className="secondary-button" type="button" disabled={busy !== null} onClick={() => void diagnoseSharing()}>{busy === "sharing-diagnostics" ? <LoaderCircle className="spin" size={15} /> : <RadioTower size={15} />} Diagnostiquer</button>
          </div>
        </section>
        {sharingDiagnostics && diagnosticCopy && diagnosticPerformance && <section className="panel sharing-diagnostics performance" aria-label="Diagnostic du partage">
          <div><span className={`diagnostic-light ${diagnosticCopy.light}`} /><span><b>{diagnosticCopy.title}</b><small>{diagnosticCopy.detail}</small></span></div>
          <div><b>Port {sharingDiagnostics.port.peerPort}</b><small>{sharingDiagnostics.port.reachable === true ? "Ouvert · test Transmission" : sharingDiagnostics.port.reachable === false ? `Fermé · mappage ${sharingDiagnostics.port.mappingEnabled ? "demandé" : "désactivé"}` : "Test indisponible"}</small></div>
          <div><b>↑ {formatRate(diagnosticPerformance.uploadRate)} · servis {diagnosticPerformance.activeUploadPeers}</b><small>Trackers OK : {sharingDiagnostics.torrents.reduce((total, torrent) => total + torrent.trackers.filter((tracker) => tracker.lastAnnounceSucceeded).length, 0)} · mise à jour auto</small></div>
          <div><b>↑ {formatBytes(diagnosticPerformance.uploadedEver)}</b>{sharingHistory && sharingHistory.sampleCount > 1 ? <small>12 h : ↑ {formatBytes(sharingHistory.uploadedBytes)} · actif {formatDuration(sharingHistory.uploadActiveSeconds)} · pic {formatRate(sharingHistory.peakUploadRate)}</small> : <small>Historique local en cours</small>}<small>Priorités : {diagnosticPerformance.highPriorityTorrents} · créneaux/torrent : {diagnosticPerformance.uploadSlotsPerTorrent}</small></div>
          <div className="sharing-peer-funnel"><b>{diagnosticPerformance.connectedPeers} connectés <span>→</span> {diagnosticPerformance.incompletePeers} incomplets <span>→</span> {diagnosticPerformance.interestedPeers} intéressés <span>→</span> {diagnosticPerformance.unchokedInterestedPeers} autorisés <span>→</span> {diagnosticPerformance.activeUploadPeers} servis</b><small>Complets : {diagnosticPerformance.completePeers} · demandes retenues : {diagnosticPerformance.locallyChokedPeers}</small></div>
        </section>}
        <section className="panel transfer-list"><div className="list-head"><div><h2>{filtered.length} torrent{filtered.length > 1 ? "s" : ""}</h2><span>Actifs {stats.active} · ↓ {formatRate(stats.rateDownload)} · ↑ {formatRate(stats.rateUpload)} · total ↑ {formatBytes(stats.uploaded)}</span></div><span className="live-indicator"><i /> DIRECT</span></div>{filtered.length ? filtered.map((torrent) => <TransferRow key={torrent.id} torrent={torrent} />) : <EmptyState icon={HardDrive} title={query ? "Aucun résultat" : "File vide"} text={query ? "Aucun torrent correspondant." : "Les nouveaux torrents apparaissent ici en pause."} />}</section>
      </>}

      {activeView === "library" && <MediaLibraryView torrents={torrents} downloadDirectory={daemon.downloadDir || ""} onDirectoryChanged={() => void refresh()} onNotice={notify} />}

      {activeView === "map" && <>
        <ViewHeader
          eyebrow="FLUX P2P EN DIRECT"
          title="Carte des pairs"
          text="Flux réels, trajectoires animées. Carte locale et positions approximatives."
          icon={Globe2}
          action={<div className="header-actions"><button className="secondary-button" type="button" disabled={locating} onClick={() => void requestMapLocation()}>{locating ? <LoaderCircle className="spin" size={15} /> : <MapPin size={15} />} {localNode ? "Relocaliser" : "Me localiser"}</button><button className="secondary-button" type="button" onClick={() => setManualPlacementOpen((current) => !current)}>Placement manuel</button></div>}
        />
        {mapError && <div className="map-inline-alert" role="alert"><AlertTriangle size={16} /><span>{mapError}</span><button type="button" onClick={() => void refreshPeerSnapshot()}><RefreshCw size={14} /> Réessayer</button></div>}
        {manualPlacementOpen && <form className="panel manual-location-panel" onSubmit={applyManualPlacement} noValidate>
          <div><span className="eyebrow">POSITION APPROXIMATIVE</span><h2>Coordonnées manuelles</h2><p>Conservation en mémoire jusqu’à la fermeture.</p></div>
          <label><span>Latitude</span><input type="number" min="-90" max="90" step="0.1" inputMode="decimal" value={manualPlacement.latitude} onChange={(event) => setManualPlacement((current) => ({ ...current, latitude: event.target.value }))} placeholder="48,9" /></label>
          <label><span>Longitude</span><input type="number" min="-180" max="180" step="0.1" inputMode="decimal" value={manualPlacement.longitude} onChange={(event) => setManualPlacement((current) => ({ ...current, longitude: event.target.value }))} placeholder="2,3" /></label>
          <div className="manual-location-actions"><button className="secondary-button" type="button" onClick={() => setManualPlacementOpen(false)}>Annuler</button><button className="primary-button" type="submit"><MapPin size={15} /> Placer</button></div>
        </form>}
        <StrategicPeerMap snapshot={peerSnapshot} localNode={localNode} onRequestLocation={() => void requestMapLocation()} />
        <section className="panel map-privacy-note"><ShieldCheck size={20} /><div><h2>Identité des pairs filtrée</h2><p>Débits Transmission. Identifiants éphémères ; IP absentes de l’interface et du journal.</p></div>{localNode && <button className="text-button" type="button" onClick={() => setLocalNode(null)}>Effacer la position</button>}</section>
      </>}

        {activeView === "security" && <><ViewHeader eyebrow="SÉCURITÉ LOCALE" title="Protection" text="Limites de confiance entre interface, moteur et fichiers." icon={ShieldCheck} /><section className="security-grid"><article className="panel security-card"><span className="security-icon blue"><RadioTower size={20} /></span><div><small>MOTEUR</small><h2>{daemon.ready ? "Boucle locale" : "Indisponible"}</h2><p>{daemon.state}{daemon.rpcVersion ? ` · RPC ${daemon.rpcVersion}` : ""}{daemon.peerPort ? ` · port ${daemon.peerPort}` : ""}</p></div><span className={`status-label ${daemon.ready ? "ok" : "bad"}`}>{daemon.ready ? "PRÊT" : "HORS LIGNE"}</span></article><article className="panel security-card"><span className="security-icon orange"><FolderLock size={20} /></span><div><small>QUARANTAINE</small><h2>Stockage séparé</h2><p title={daemon.quarantineDir}>{daemon.quarantineDir || "Chemin géré localement"}</p></div><span className="status-label ok">LOCAL</span></article><article className="panel security-card"><span className="security-icon cyan"><HardDrive size={20} /></span><div><small>BIBLIOTHÈQUE</small><h2>Dossier contrôlé</h2><p title={daemon.downloadDir}>{daemon.downloadDir || "Chemin indisponible"}</p></div><span className="status-label ok">CONTRÔLÉ</span></article><article className="panel security-card"><span className="security-icon navy"><ListChecks size={20} /></span><div><small>JOURNAL</small><h2>Traçabilité locale</h2><p>Actions et résultats, sans passkey ni magnet complet.</p></div><button type="button" onClick={() => setActiveView("audit")}>Ouvrir</button></article></section><section className="panel trust-boundary"><div><span className="eyebrow">CONFIANCE</span><h2>Accès système isolé</h2></div><div className="trust-flow"><span><LayoutDashboard size={18} /><b>Interface</b><small>Entrées non fiables</small></span><ChevronRight /><span><LockKeyhole size={18} /><b>IPC filtré</b><small>Schémas stricts</small></span><ChevronRight /><span><ShieldCheck size={18} /><b>Agent local</b><small>Politiques et journal</small></span><ChevronRight /><span><Network size={18} /><b>Moteur P2P</b><small>Profil isolé</small></span></div></section><section className="panel security-notes"><Info size={18} /><div><h2>Visibilité réseau</h2><p>L’adresse réseau reste visible des pairs et trackers. Contenus autorisés et règles des communautés applicables.</p></div></section></>}

      {activeView === "audit" && <><ViewHeader eyebrow="JOURNAL LOCAL" title="Traçabilité" text="Événements du processus principal. Secrets filtrés." icon={History} action={<button className="secondary-button" type="button" onClick={() => void loadAudit()}><RefreshCw size={15} /> Actualiser</button>} /><section className="panel audit-panel"><div className="audit-head"><div><h2>{auditEntries.length} événement{auditEntries.length > 1 ? "s" : ""}</h2><span>Plus récents d’abord · limite 250</span></div><span><LockKeyhole size={13} /> local</span></div>{auditEntries.length ? <div className="audit-list">{auditEntries.map((entry, index) => <article key={entry.id ?? entry.seq ?? `${entry.timestamp ?? entry.ts}-${index}`}><span className={`audit-dot ${String(entry.outcome ?? entry.level ?? "").toLowerCase()}`} /><time>{formatAuditTime(entry.timestamp ?? entry.ts)}</time><div><strong>{entry.action || entry.event || "Événement local"}</strong><small>{auditDetail(entry)}</small></div><span className="audit-outcome">{entry.outcome || entry.level || "info"}</span></article>)}</div> : <EmptyState icon={History} title="Journal vide" text="Aucune opération enregistrée." />}</section></>}

      <footer className="app-footer"><span><ShieldCheck size={13} /> Slyorrent · protection Slyorus</span><span>Local · sans compte · sans télémétrie distante</span></footer>
    </main>

    {importOpen && <div className="modal-backdrop">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <header><div><span className="eyebrow">IMPORT LOCAL</span><h2 id="import-title">Fichier .torrent</h2></div><button className="icon-button" type="button" onClick={closeImport} aria-label="Fermer"><X size={17} /></button></header>
        <div className="dialog-body import-dialog-body">
          <span className="dialog-owl"><img src="./slyorus.png" alt="" /></span>
          {externalImport ? <p className="external-import-name"><b>{externalImport.name}</b><br />{formatBytes(externalImport.size)} · Ouvert depuis Windows · Ajout en pause</p> : <p>Contrôle local puis ajout en pause.</p>}
          <DestinationControl
            id="import"
            destination={importDestination}
            defaultDirectory={daemon.downloadDir}
            busy={busy === "destination-import"}
            disabled={busy !== null}
            onChoose={() => void chooseDestination("import")}
            onSubfolderChange={(checked) => setImportDestination((current) => ({ ...current, createSubfolder: checked }))}
          />
          <label className="consent"><input type="checkbox" checked={importRights} onChange={(event) => setImportRights(event.target.checked)} /><span className="custom-check"><Check size={13} /></span><span><b>Droits de téléchargement et de partage confirmés</b><small>Confirmation enregistrée avec l’import.</small></span></label>
        </div>
        <footer><button className="secondary-button" type="button" onClick={closeImport}>Annuler</button><button className="primary-button" type="button" disabled={!importRights || busy !== null} onClick={() => void importTorrent()}>{busy === "import" ? <LoaderCircle className="spin" size={16} /> : <FileInput size={16} />} Importer</button></footer>
      </section>
    </div>}

    {policyTarget && <div className="modal-backdrop"><form className="dialog" role="dialog" aria-modal="true" aria-labelledby="policy-title" onSubmit={(event) => void savePolicy(event)}><header><div><span className="eyebrow">PARTAGE</span><h2 id="policy-title">Limites du torrent</h2><p>{policyTarget.name}</p></div><button className="icon-button" type="button" onClick={() => setPolicyTarget(null)} aria-label="Fermer"><X size={17} /></button></header><div className="dialog-body form-grid"><label><span>Ratio maximum</span><input type="number" min="0" max="100" step="0.1" value={policy.ratioLimit} onChange={(event) => setPolicy((current) => ({ ...current, ratioLimit: Number(event.target.value) }))} /><small>0 = illimité</small></label><label><span>Inactivité maximale</span><div className="input-suffix"><input type="number" min="0" max="10080" step="1" value={policy.idleMinutes} onChange={(event) => setPolicy((current) => ({ ...current, idleMinutes: Number(event.target.value) }))} /><em>min</em></div><small>0 = aucun arrêt</small></label><label><span>Débit d’envoi maximum</span><div className="input-suffix"><input type="number" min="0" max="1000000" step="64" value={policy.uploadLimitKbps} onChange={(event) => setPolicy((current) => ({ ...current, uploadLimitKbps: Number(event.target.value) }))} /><em>Ko/s</em></div><small>0 = limite globale</small></label><div className="policy-note"><Gauge size={18} /><p>Application par le moteur · modification journalisée.</p></div></div><footer><button className="secondary-button" type="button" onClick={() => setPolicyTarget(null)}>Annuler</button><button className="primary-button" type="submit" disabled={busy !== null}>{busy === `policy-${policyTarget.id}` ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />} Enregistrer</button></footer></form></div>}

    {globalPolicyOpen && <div className="modal-backdrop">
      <form className="dialog global-policy-dialog" role="dialog" aria-modal="true" aria-labelledby="global-policy-title" onSubmit={(event) => void saveGlobalPolicy(event)}>
        <header><div><span className="eyebrow">PARTAGE GLOBAL</span><h2 id="global-policy-title">Réglages d’envoi</h2><p>Effet local uniquement. La sélection reste décidée par les pairs.</p></div><button className="icon-button" type="button" onClick={() => setGlobalPolicyOpen(false)} aria-label="Fermer"><X size={17} /></button></header>
        <div className="dialog-body form-grid">
          <div className="global-toggle"><input id="global-priority" type="checkbox" aria-label="Appliquer les paramètres globaux" checked={globalSharing.enabled} onChange={(event) => setGlobalSharing((current) => ({ ...current, enabled: event.target.checked }))} /><span><b>Paramètres globaux</b><small>Désactivés : politiques par torrent.</small></span></div>
          <div className="global-toggle"><input id="local-bandwidth-priority" type="checkbox" aria-label="Favoriser localement les torrents terminés" checked={globalSharing.priorityMode} onChange={(event) => setGlobalSharing((current) => ({ ...current, priorityMode: event.target.checked }))} /><span><b>Priorité locale</b><small>Transferts actifs, puis seeds avec demande tracker. Effet après redémarrage si indiqué.</small></span></div>
          <label><span>Ratio maximum global</span><input type="number" min="0" max="100" step="0.1" value={globalSharing.ratioLimit ?? 0} onChange={(event) => setGlobalSharing((current) => ({ ...current, ratioLimit: Number(event.target.value) || null }))} /><small>0 = illimité</small></label>
          <label><span>Inactivité maximale globale</span><div className="input-suffix"><input type="number" min="0" max="10080" step="1" value={globalSharing.idleMinutes ?? 0} onChange={(event) => setGlobalSharing((current) => ({ ...current, idleMinutes: Number(event.target.value) || null }))} /><em>min</em></div><small>0 = aucun arrêt</small></label>
          <label><span>Débit d’envoi total maximum</span><div className="input-suffix"><input type="number" min="0" max="1000000" step="64" value={globalSharing.uploadLimitKbps ?? 0} onChange={(event) => setGlobalSharing((current) => ({ ...current, uploadLimitKbps: Number(event.target.value) || null }))} /><em>Ko/s</em></div><small>0 = illimité · saturation déconseillée</small></label>
          <div className="global-toggle"><input id="global-port-mapping" type="checkbox" aria-label="Tenter l’ouverture automatique du port" checked={globalSharing.portMapping} onChange={(event) => setGlobalSharing((current) => ({ ...current, portMapping: event.target.checked }))} /><span><b>Ouverture automatique du port</b><small>UPnP/NAT-PMP · routeur de confiance · ouverture non garantie.</small></span></div>
          <div className="policy-note"><ShieldCheck size={18} /><p>Passkey confinée au moteur · aucun trafic, ratio ou identifiant falsifié.</p></div>
          {sharingApplyResult?.restartRequired && <div className="restart-note"><RefreshCw size={17} /><p><b>Redémarrage requis</b><small>Finalise les créneaux d’envoi.</small></p></div>}
        </div>
        <footer><button className="secondary-button" type="button" onClick={() => setGlobalPolicyOpen(false)}>Annuler</button><button className="primary-button" type="submit" disabled={busy !== null}>{busy === "global-sharing" ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />} Appliquer</button></footer>
      </form>
    </div>}

    {notice && <div className={`toast ${notice.tone}`} role="status" aria-live="polite">{notice.tone === "success" ? <CheckCircle2 size={17} /> : notice.tone === "error" ? <AlertTriangle size={17} /> : <Info size={17} />}<span>{notice.message}</span><button type="button" onClick={() => setNotice(null)} aria-label="Fermer"><X size={14} /></button></div>}
  </div>;
}

function ViewHeader({ eyebrow, title, text, icon: Icon, action }: { eyebrow: string; title: string; text: string; icon: typeof ShieldCheck; action?: React.ReactNode }) {
  return <section className="view-header"><div><span className="title-icon"><Icon size={21} /></span><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{text}</p></div></div>{action}</section>;
}

function EmptyState({ icon: Icon, title, text }: { icon: typeof ShieldCheck; title: string; text: string }) {
  return <div className="empty-state"><span><Icon size={24} /></span><h3>{title}</h3><p>{text}</p></div>;
}

function formatAuditTime(value?: string | number) {
  if (value === undefined || value === null) return "—";
  const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : dateFormat.format(date);
}

function auditDetail(entry: UiAuditEntry) {
  if (entry.torrentName || entry.resource || entry.detail) return entry.torrentName || entry.resource || entry.detail;
  const details = entry.details;
  if (!details) return entry.actor ? `Acteur local : ${entry.actor}` : "Action enregistrée et chaînée";
  for (const key of ["name", "status", "reason", "result"] as const) {
    const value = details[key];
    if (typeof value === "string" && value.length <= 160) return value;
  }
  return entry.actor ? `Acteur local : ${entry.actor}` : "Détails protégés dans le journal local";
}
