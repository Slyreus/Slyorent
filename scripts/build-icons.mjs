import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import electron from "electron";
import { convertIcon } from "app-builder-lib/out/util/iconConverter.js";
import { inspectRgbaPng, inspectWindowsIco } from "./icon-resources.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "public", "slyorrent-logo.svg");
const staging = path.join(root, ".runtime", "icon-build");
await mkdir(staging, { recursive: true });
const temporary = await mkdtemp(path.join(staging, "build-"));
try {
  const rendered = path.join(temporary, "slyorrent-logo.png");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  await promisify(execFile)(electron, [path.join(root, "scripts", "render-logo.mjs"), source, rendered], { windowsHide: true, timeout: 45_000, env: environment });
  inspectRgbaPng(await readFile(rendered));
  const { icons, isFallback } = await convertIcon({ sources: [rendered], fallbackSources: [], roots: [root], format: "ico", outDir: temporary });
  if (isFallback || icons.length !== 1) throw new Error("Conversion du logo impossible.");
  inspectWindowsIco(await readFile(icons[0].file));
  await copyFile(rendered, path.join(root, "public", "slyorrent-logo.png"));
  await copyFile(icons[0].file, path.join(root, "public", "slyorrent.ico"));
  console.log("Icône Windows : 7 résolutions RGBA, de 16 à 256 pixels.");
} finally {
  const relative = path.relative(staging, temporary);
  if (!relative.startsWith("..") && !path.isAbsolute(relative) && relative.startsWith("build-")) await rm(temporary, { recursive: true, force: true });
}
