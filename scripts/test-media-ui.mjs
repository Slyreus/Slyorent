import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import electron from "electron";
import ffmpeg from "ffmpeg-static";

const execute = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "slyorent-media-ui-"));
try {
  await build({ configFile: false, root: path.join(repository, "tests", "ui"), base: "./", publicDir: path.join(repository, "public"), plugins: [react()], logLevel: "warn", build: { outDir: path.join(temporary, "dist"), emptyOutDir: false } });
  await execute(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=60", "-f", "lavfi", "-i", "sine=frequency=440:duration=60", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart", "-shortest", path.join(temporary, "sample.mp4")], { windowsHide: true, timeout: 30_000 });
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = await execute(electron, [path.join(repository, "tests", "ui", "runner.mjs"), temporary], { windowsHide: true, timeout: 90_000, env: environment, maxBuffer: 1024 * 1024 });
  process.stdout.write(result.stdout);
} catch (error) {
  process.stderr.write(String(error.stdout || error.message));
  process.exitCode = 1;
} finally {
  if (path.resolve(temporary).startsWith(`${path.resolve(os.tmpdir())}${path.sep}slyorent-media-ui-`)) await rm(temporary, { recursive: true, force: true });
  else { process.stderr.write("Dossier de test inattendu, conservé sans modification."); process.exitCode = 1; }
}
