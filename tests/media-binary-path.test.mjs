import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveMediaBinaryPath } from "../electron/media-binary-path.mjs";

test("le moteur média de développement conserve son chemin physique", () => {
  const application = path.resolve("local-app");
  const executable = path.join(application, "node_modules", "ffmpeg-static", "ffmpeg.exe");
  assert.equal(resolveMediaBinaryPath(executable, application), executable);
});

test("les deux moteurs embarqués sont lancés depuis app.asar.unpacked", () => {
  const application = path.resolve("une application", "resources", "app.asar");
  for (const module of ["ffmpeg-static", path.join("@derhuerst", "ffprobe-static")]) {
    const file = module.endsWith("ffmpeg-static") ? "ffmpeg.exe" : "ffprobe.exe";
    const relative = path.join("node_modules", module, file);
    assert.equal(resolveMediaBinaryPath(path.join(application, relative), application), path.join(`${application}.unpacked`, relative));
    assert.equal(resolveMediaBinaryPath(path.join(`${application}.unpacked`, relative), application), path.join(`${application}.unpacked`, relative));
  }
});

test("un nom de dossier ressemblant à ASAR n'est pas réécrit", () => {
  for (const name of ["app.asar.backup", "app.asar.unpacked", "application-asar"]) {
    const application = path.resolve(name);
    const executable = path.join(application, "node_modules", "ffmpeg-static", "ffmpeg.exe");
    assert.equal(resolveMediaBinaryPath(executable, application), executable);
  }
});

test("un moteur extérieur à l'application est refusé", () => {
  const application = path.resolve("local-app", "resources", "app.asar");
  for (const candidate of [
    path.resolve("autre-dossier", "ffmpeg.exe"),
    path.join(`${application}.backup`, "ffmpeg.exe"),
    path.join(`${application}.unpacked-backup`, "ffmpeg.exe"),
    path.join(application, "..", "ffmpeg.exe"),
    application,
  ]) assert.throws(() => resolveMediaBinaryPath(candidate, application), /fourni avec l'application/u);
});

test("les chemins relatifs, absents et contenant un caractère nul sont refusés", () => {
  for (const candidate of [undefined, null, "", "ffmpeg.exe", `${path.resolve("ffmpeg")}\0.exe`]) {
    assert.throws(() => resolveMediaBinaryPath(candidate), /invalide/u);
  }
});
