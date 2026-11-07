import { AlertTriangle, CheckCircle2, ListChecks, ScanSearch } from "lucide-react";
import type { ProtectionAlert } from "../../lib/protection-alerts";

export function ProtectionAlerts({ alerts, busy, onValidate, onTransfers, onAudit }: { alerts: ProtectionAlert[]; busy: boolean; onValidate: (id: number) => void; onTransfers: (name: string) => void; onAudit: () => void }) {
  return <section className={`panel protection-alerts ${alerts.length ? "has-alerts" : ""}`} aria-labelledby="protection-alerts-heading" aria-live="polite">
    <header>{alerts.length ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}<div><h2 id="protection-alerts-heading">{alerts.length ? `${alerts.length} problème${alerts.length > 1 ? "s" : ""} à traiter` : "Aucune alerte en cours"}</h2>{alerts.length > 0 && <p>Transferts et contrôles en erreur</p>}</div></header>
    {alerts.map(alert => <article key={alert.key} className={`protection-alert ${alert.danger ? "is-danger" : ""}`}><div><span className="protection-alert-kind">{alert.danger ? "ANTIVIRUS" : "À VÉRIFIER"}</span><h3>{alert.title}</h3><strong>{alert.name}</strong><p>{alert.message}</p><details><summary>Détails du moteur</summary><pre>{alert.detail}</pre></details></div><div className="protection-alert-actions">{alert.canValidate && alert.torrentId !== undefined && <button type="button" disabled={busy} className="secondary-button" onClick={() => onValidate(alert.torrentId!)}><ScanSearch size={15} /> Vérifier et ranger</button>}{alert.torrentId !== undefined && <button type="button" className="secondary-button" onClick={() => onTransfers(alert.name)}>Voir le transfert</button>}<button type="button" className="secondary-button" onClick={onAudit}><ListChecks size={15} /> Journal</button></div></article>)}
  </section>;
}
