import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import electron from "electron";

const execute = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preview = process.argv.includes("--preview");
const temporary = await mkdtemp(path.join(os.tmpdir(), "slyorent-map-ui-"));
try {
  await build({ configFile: false, root: path.join(repository, "tests", "map-ui"), base: "./", publicDir: path.join(repository, "public"), plugins: [react()], logLevel: "warn", build: { outDir: path.join(temporary, "dist"), emptyOutDir: false } });
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = await execute(electron, [path.join(repository, "tests", "map-ui", "runner.mjs"), temporary, ...(preview ? ["--preview"] : [])], { windowsHide: false, timeout: preview ? 610_000 : 65_000, env: environment, maxBuffer: 1024 * 1024 });
  process.stdout.write(result.stdout);
} catch (error) {
  process.stderr.write(String(error.stdout || error.message));
  process.exitCode = 1;
} finally {
  if (path.resolve(temporary).startsWith(`${path.resolve(os.tmpdir())}${path.sep}slyorent-map-ui-`)) await rm(temporary, { recursive: true, force: true });
  else { process.stderr.write("Dossier de test inattendu, conservé sans modification."); process.exitCode = 1; }
}
