import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

const root = resolve(process.argv[2] || ".");
const ignoredDirectories = new Set([
  ".git", ".next", ".runtime", ".vinext", ".vite", ".wrangler",
  "coverage", "dist", "node_modules", "out", "release",
]);
const textExtensions = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".jsonc", ".jsx", ".md",
  ".mjs", ".ps1", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const forbiddenFileExtensions = new Set([
  ".7z", ".dll", ".dmp", ".env", ".exe", ".key", ".mmdb", ".msi",
  ".part", ".pem", ".pfx", ".resume", ".torrent", ".zip",
]);
const forbiddenFileNames = new Set([".npmrc", ".yarnrc", "credentials", "credentials.json"]);
const secretPatterns = [
  [/(?:gho|ghp|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/gu, "jeton GitHub"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu, "clé API"],
  [/(?:AKIA|ASIA)[A-Z0-9]{16}/gu, "identifiant AWS"],
];
const privateKeyMarker = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
const currentUsername = String(process.env.USERNAME || "").trim();
const violations = [];

function normalized(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

function inspectText(filePath, relativePath) {
  const content = readFileSync(filePath, "utf8");
  const windowsProfiles = /[A-Za-z]:[\\/]Users[\\/]([^\\/\s"'`<>]+)/giu;
  for (const match of content.matchAll(windowsProfiles)) {
    if (!["public", "default", "default user"].includes(String(match[1]).toLowerCase())) {
      violations.push(`${relativePath} — chemin de profil Windows personnel`);
    }
  }
  if (currentUsername.length >= 3 && currentUsername.toLowerCase() !== "public") {
    const escaped = currentUsername.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "iu").test(content)) violations.push(`${relativePath} — nom du profil Windows courant`);
  }
  if (content.includes(privateKeyMarker)) violations.push(`${relativePath} — clé privée`);
  for (const [pattern, label] of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) violations.push(`${relativePath} — ${label}`);
  }
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const filePath = resolve(directory, entry.name);
    const relativePath = normalized(relative(root, filePath));
    const info = lstatSync(filePath);
    if (info.isSymbolicLink()) {
      violations.push(`${relativePath} — lien symbolique non publié`);
      continue;
    }
    if (info.isDirectory()) {
      walk(filePath);
      continue;
    }
    if (!info.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    const lowerName = entry.name.toLowerCase();
    if (lowerName === ".env" || lowerName.startsWith(".env.") || forbiddenFileNames.has(lowerName)) {
      violations.push(`${relativePath} — fichier de configuration sensible`);
    }
    if (forbiddenFileExtensions.has(extension)) violations.push(`${relativePath} — artefact local sensible ou binaire`);
    if (textExtensions.has(extension)) inspectText(filePath, relativePath);
  }
}

walk(root);
const unique = [...new Set(violations)].sort();
if (unique.length > 0) {
  console.error("Garde publication: ECHEC");
  for (const violation of unique) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Garde publication: OK — aucun secret, chemin personnel ou artefact local détecté.");
}
