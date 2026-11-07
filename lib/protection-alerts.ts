export type ProtectionAlert = { key: string; torrentId?: number; name: string; title: string; message: string; detail: string; danger: boolean; canValidate: boolean };
type AlertTorrent = { id: number; name: string; errorString?: string; percentDone?: number; files?: { name: string; scanStatus?: string }[] };
const blocked = (status = "") => /infect|threat|blocked|quarantin|malware|error/iu.test(status);

export function protectionAlerts(torrents: AlertTorrent[], engineError = ""): ProtectionAlert[] {
  const alerts: ProtectionAlert[] = [];
  if (engineError) alerts.push({ key: "engine", name: "Moteur local", title: "Moteur indisponible", message: "Les transferts sont suspendus.", detail: engineError, danger: false, canValidate: false });
  for (const torrent of torrents) {
    const files = torrent.files?.filter(file => blocked(file.scanStatus)) || [];
    const error = torrent.errorString || "";
    if (!error && !files.length) continue;
    let title = "Erreur du transfert", message = "Le moteur signale une erreur.";
    const danger = files.some(file => /infect|threat|malware/iu.test(file.scanStatus || ""));
    if (files.length) { title = danger ? "Fichier signalé par l’antivirus" : "Contrôle des fichiers bloqué"; message = "La lecture et le partage restent bloqués. Consultez le détail avant de relancer le contrôle."; }
    else if (/too long|trop long|enametoolong|\b206\b|file_name_exced_range/iu.test(error)) { title = "Chemin Windows trop long"; message = "Le déplacement vers la bibliothèque a échoué. Relancez le contrôle pour terminer le rangement."; }
    else if (/no space|disk full|espace.*(?:disque|insuffisant)|enospc|\(112\)/iu.test(error)) { title = "Stockage insuffisant"; message = "Libérez de l’espace sur le disque, puis reprenez le transfert."; }
    else if (/permission denied|access.*denied|accès.*refus|eacces|\(5\)/iu.test(error)) { title = "Accès au dossier refusé"; message = "Vérifiez l’accès en écriture au dossier de destination."; }
    alerts.push({ key: `torrent-${torrent.id}`, torrentId: torrent.id, name: torrent.name, title, message, detail: [error, ...files.map(file => `${file.name} · ${file.scanStatus}`)].filter(Boolean).join("\n"), danger, canValidate: !danger && (torrent.percentDone || 0) >= .999999 });
  }
  return alerts;
}
