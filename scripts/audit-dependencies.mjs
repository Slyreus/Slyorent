import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const npm = process.env.npm_execpath;
if (!npm) throw new Error("Lancer le contrôle avec npm run audit:dependencies.");

const result = spawnSync(process.execPath, [npm, "audit", "--json"], {
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
  windowsHide: true,
});
if (result.error) throw result.error;
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  throw new Error("Le registre npm n’a pas renvoyé de rapport d’audit.");
}
if (report.error || !report.metadata?.vulnerabilities || !report.vulnerabilities || ![0, 1].includes(result.status)) {
  throw new Error("Audit npm indisponible.");
}

const findings = Object.values(report.vulnerabilities);
if (!findings.length && result.status === 0 && report.metadata.vulnerabilities.total === 0) {
  console.log("Audit npm : aucune vulnérabilité signalée.");
} else {
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  // Ce seul avis reste sans version corrigée sur npm. Il concerne les globs du build.
  const picomatchAdvisory = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
  const advisories = findings.flatMap(finding => finding.via.filter(item => typeof item === "object"));
  const onlyKnownDevAdvisory = result.status === 1
    && advisories.length > 0
    && advisories.every(item => item.name === "picomatch" && item.url === picomatchAdvisory)
    && findings.every(finding => finding.via.length > 0
      && finding.via.every(item => typeof item !== "string" || Object.hasOwn(report.vulnerabilities, item))
      && finding.nodes.length > 0
      && finding.nodes.every(node => lock.packages[node]?.dev === true));

  if (!onlyKnownDevAdvisory) {
    console.error(result.stdout.trim());
    process.exitCode = 1;
  } else {
    console.warn(`Audit npm : ${findings.length} dépendances de développement liées au même avis sans correctif : ${picomatchAdvisory}`);
    console.log("Aucun paquet de production concerné.");
  }
}
