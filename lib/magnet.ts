export type Verdict = "clean" | "review" | "blocked";

export type AnalysisResult = {
  name: string;
  hash: string;
  trackers: number;
  verdict: Verdict;
  score: number;
  reasons: string[];
  files: Array<{ name: string; size: string; safe: boolean }>;
};

function normalizeTitle(value: string) {
  const printable = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      const bidiControl = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
      return code > 31 && code !== 127 && !bidiControl;
    })
    .join("");
  return printable
    .replace(/[\\/]+/g, "_")
    .replace(/\.{2,}/g, ".")
    .trim()
    .slice(0, 120) || "Contenu sans titre";
}

export function inspectMagnet(rawValue: string): { error?: string; result?: AnalysisResult } {
  const raw = rawValue.trim();
  if (!raw) return { error: "Collez un lien magnet pour lancer l’analyse." };
  if (raw.length > 4096) return { error: "Ce lien dépasse la limite de 4 096 caractères." };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "Le lien n’est pas un magnet valide." };
  }

  if (url.protocol !== "magnet:") return { error: "Seuls les liens commençant par magnet: sont acceptés." };

  const exactTopics = url.searchParams.getAll("xt");
  const btih = exactTopics.find((item) => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(item));
  const btmh = exactTopics.find((item) => /^urn:btmh:1220[a-f0-9]{64}$/i.test(item));
  const topic = btih ?? btmh;
  if (!topic) return { error: "Infohash BTIH/BTMH absent ou mal formé." };

  const allTrackers = url.searchParams.getAll("tr");
  const trackers = allTrackers.slice(0, 32);
  const rawDisplayName = url.searchParams.get("dn") ?? "Contenu sans titre";
  const displayName = normalizeTitle(rawDisplayName);
  const reasons: string[] = [];
  const suspiciousExtension = /\.(exe|scr|bat|cmd|com|msi|ps1|vbs|jar)$/i.test(displayName);
  const doubleExtension = /\.(mp4|mkv|avi|pdf|jpg|png|txt)\.(exe|scr|bat|cmd|com)$/i.test(displayName);
  const hasBidiControl = Array.from(rawDisplayName).some((character) => {
    const code = character.charCodeAt(0);
    return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
  });
  const hasSuspiciousPath = /(^|[\\/])\.\.([\\/]|$)|^[a-z]:[\\/]|^\\\\/i.test(rawDisplayName);
  const auxiliaryUrls = [
    ...url.searchParams.getAll("ws"),
    ...url.searchParams.getAll("as"),
    ...url.searchParams.getAll("xs"),
    ...url.searchParams.getAll("x.pe"),
  ];
  const unexpectedTracker = allTrackers.some((tracker) => {
    try {
      const parsed = new URL(tracker);
      const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      const ipv6Literal = host.includes(":");
      const privateLiteral = host === "localhost" || host.endsWith(".local") || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === "::1" || (ipv6Literal && (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")));
      return !["udp:", "http:", "https:"].includes(parsed.protocol) || Boolean(parsed.username || parsed.password) || privateLiteral;
    } catch {
      return true;
    }
  });

  if (suspiciousExtension) reasons.push("Le nom annonce un fichier exécutable.");
  if (doubleExtension) reasons.push("Une double extension trompeuse a été détectée.");
  if (trackers.length > 8) reasons.push("Le lien contient un nombre inhabituel de trackers.");
  if (allTrackers.length > 32) reasons.push("La limite de 32 trackers autorisés est dépassée.");
  if (unexpectedTracker) reasons.push("Un tracker invalide, privé ou non autorisé est présent.");
  if (trackers.length === 0) reasons.push("Aucun tracker déclaré : disponibilité à confirmer via DHT isolée.");
  if (auxiliaryUrls.length > 0) reasons.push("Webseed ou source auxiliaire présente : accès réseau interdit dans le navigateur.");
  if (hasSuspiciousPath) reasons.push("Le nom déclaré ressemble à un chemin ou contient une traversée.");
  if (hasBidiControl) reasons.push("Des caractères de direction Unicode masqués ont été supprimés.");

  const verdict: Verdict = suspiciousExtension || doubleExtension ? "blocked" : reasons.length ? "review" : "clean";
  const score = verdict === "clean" ? 68 : verdict === "review" ? 48 : 12;
  return {
    result: {
      name: displayName,
      hash: topic.split(":").pop()?.toUpperCase() ?? "",
      trackers: allTrackers.length,
      verdict,
      score,
      reasons,
      // A magnet does not contain a trustworthy file list. Real metadata is
      // displayed only after the local daemon has resolved and validated it.
      files: [],
    },
  };
}
