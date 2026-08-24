import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(process.argv[2] ?? dirname(scriptPath), process.argv[2] ? "." : "..");
const violations = [];

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".runtime",
  ".vinext",
  ".vite",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const textExtensions = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".jsonc", ".jsx", ".md", ".mjs",
  ".ps1", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);

const ownRelativePath = relative(repositoryRoot, scriptPath).replaceAll("\\", "/");
const hostedDomain = ["chatgpt", "site"].join(".");
const sitesPackage = ["@openai", "sites"].join("/");
const remoteMediaExtension = /https?:\/\/[^\s"'`<>)\\]+\.(?:avif|gif|jpe?g|m3u8|m4a|m4v|mkv|mov|mp3|mp4|ogg|ogv|png|svg|wav|webm|webp)(?:[?#][^\s"'`<>)\\]*)?/giu;
const remoteMediaAttribute = /(?:poster|src)\s*[:=]\s*["'`](https?:\/\/[^"'`]+)["'`]/giu;
const remoteCssAsset = /url\(\s*["']?https?:\/\//giu;
const globalBind = /\b0\.0\.0\.0\b/gu;

function addViolation(path, message, content, offset = 0) {
  const normalizedPath = relative(repositoryRoot, path).replaceAll("\\", "/") || ".";
  const line = content ? content.slice(0, offset).split(/\r?\n/u).length : undefined;
  violations.push(`${normalizedPath}${line ? `:${line}` : ""} — ${message}`);
}

function inspectTextFile(path) {
  const normalizedPath = relative(repositoryRoot, path).replaceAll("\\", "/");
  if (normalizedPath === ownRelativePath) return;

  const content = readFileSync(path, "utf8");
  const lowerContent = content.toLowerCase();

  const hostedIndex = lowerContent.indexOf(hostedDomain);
  if (hostedIndex >= 0) addViolation(path, "reference a un domaine d'hebergement public interdite", content, hostedIndex);

  const sitesIndex = lowerContent.indexOf(sitesPackage);
  if (sitesIndex >= 0) addViolation(path, "dependance ou import Sites interdit", content, sitesIndex);

  for (const match of content.matchAll(globalBind)) {
    addViolation(path, "ecoute globale interdite; l'UI et le RPC doivent rester sur la boucle locale", content, match.index);
  }
  for (const match of content.matchAll(remoteMediaExtension)) {
    addViolation(path, "media distant HTTP(S) interdit; embarquez une ressource locale", content, match.index);
  }
  for (const match of content.matchAll(remoteMediaAttribute)) {
    addViolation(path, "source ou affiche distante HTTP(S) interdite", content, match.index);
  }
  for (const match of content.matchAll(remoteCssAsset)) {
    addViolation(path, "ressource CSS distante interdite", content, match.index);
  }
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

    const path = resolve(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (stat.isFile() && textExtensions.has(extname(entry.name).toLowerCase())) inspectTextFile(path);
  }
}

const hostingManifest = resolve(repositoryRoot, ".openai", "hosting.json");
if (existsSync(hostingManifest)) addViolation(hostingManifest, "manifeste d'hebergement interdit dans l'application locale");

for (const artifact of ["wrangler.toml", "wrangler.json", "wrangler.jsonc"]) {
  const path = resolve(repositoryRoot, artifact);
  if (existsSync(path)) addViolation(path, "configuration Cloudflare Workers interdite");
}

const cloudPackages = /^(?:@cloudflare\/|@opennextjs\/cloudflare$|miniflare$|workerd$|wrangler$)/iu;
const packagePath = resolve(repositoryRoot, "package.json");
if (existsSync(packagePath)) {
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(packageJson[section] ?? {})) {
      if (cloudPackages.test(name) || name.toLowerCase() === sitesPackage) {
        addViolation(packagePath, `dependance cloud interdite dans ${section}: ${name}`);
      }
    }
  }
}

const lockPath = resolve(repositoryRoot, "package-lock.json");
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  for (const packageKey of Object.keys(lock.packages ?? {})) {
    const dependencyName = packageKey.replaceAll("\\", "/").split("node_modules/").at(-1);
    if (dependencyName && (cloudPackages.test(dependencyName) || dependencyName.toLowerCase() === sitesPackage)) {
      addViolation(lockPath, `paquet cloud verrouille interdit: ${dependencyName}`);
    }
  }
}

try {
  walk(repositoryRoot);
} catch (error) {
  violations.push(`inspection incomplete — ${error instanceof Error ? error.message : String(error)}`);
}

const uniqueViolations = [...new Set(violations)];
if (uniqueViolations.length > 0) {
  console.error("Garde local-only: ECHEC");
  for (const violation of uniqueViolations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Garde local-only: OK — aucun hebergement, bind global, media distant ou runtime cloud detecte.");
}
