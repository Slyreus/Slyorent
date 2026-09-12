import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { inspectRgbaPng, inspectWindowsIco, WINDOWS_ICON_SIZES } from "../scripts/icon-resources.mjs";

const local = (file) => fileURLToPath(new URL(`../${file}`, import.meta.url));
const read = (file) => readFile(local(file));

test("le logo vectoriel reste bleu et blanc, sans bec ni fond opaque", async () => {
  const svg = (await read("public/slyorrent-logo.svg")).toString("utf8");
  assert.match(svg, /viewBox="0 0 1254 1254"/);
  assert.match(svg, /<rect x="78" y="78" width="1098" height="1098" rx="282"/);
  assert.equal((svg.match(/<path\b/gu) || []).length, 2);
  assert.deepEqual([...new Set([...svg.matchAll(/fill="([^"]+)"/gu)].map((match) => match[1]))].sort(), ["#087fff", "#fff"]);
  assert.doesNotMatch(svg, /<(?:image|script|foreignObject|filter|linearGradient|radialGradient)\b|\b(?:href|onload)=/iu);
});

test("le logo transparent et les sept tailles Windows sont en RGBA 32 bits", async () => {
  assert.ok(inspectRgbaPng(await read("public/slyorrent-logo.png")).width >= 1024);
  assert.deepEqual(inspectWindowsIco(await read("public/slyorrent.ico")).map((entry) => entry.width), WINDOWS_ICON_SIZES);
});

test("une icône RGB sans alpha, tronquée ou mal dimensionnée est refusée", async () => {
  const logo = await read("public/slyorrent-logo.png");
  const rgb = Buffer.from(logo); rgb[25] = 2;
  assert.throws(() => inspectRgbaPng(rgb), /RGBA/);
  const ico = await read("public/slyorrent.ico");
  assert.throws(() => inspectWindowsIco(ico.subarray(0, 30)), /tronqué/);
  const wrongSize = Buffer.from(ico); wrongSize[6] = 32;
  assert.throws(() => inspectWindowsIco(wrongSize), /incohérente/);
});

test("Windows extrait les deux tailles d'icône et reconnaît la transparence réelle", { skip: process.platform !== "win32" }, async () => {
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", local("scripts/check-windows-icon.ps1"), "-FilePath", local("public/slyorrent.ico"), "-SourcePng", local("public/slyorrent-logo.png")], { windowsHide: true, timeout: 30_000 });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.LargeIcon, true); assert.equal(result.SmallIcon, true); assert.equal(result.AlphaChecked, true);
  assert.equal(result.RoundedCornersChecked, true); assert.equal(result.BeakRemovedChecked, true);
});

test("l'exécutable, l'installateur et Ouvrir avec utilisent le même logo", async () => {
  const config = (await read("electron-builder.yml")).toString("utf8");
  assert.match(config, /icon: public\/slyorrent\.ico/);
  assert.match(config, /installerIcon: public\/slyorrent\.ico/);
  assert.match(config, /uninstallerIcon: public\/slyorrent\.ico/);
  assert.match(config, /to: slyorrent\.ico/);
  const installer = (await read("build/file-associations.nsh")).toString("utf8");
  assert.match(installer, /Applications\\Slyorrent\.exe\\DefaultIcon/);
  assert.match(installer, /Capabilities" "ApplicationIcon"/);
  assert.doesNotMatch(installer, /UserChoice/);
});
