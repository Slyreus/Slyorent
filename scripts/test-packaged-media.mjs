import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import electron from "electron";
import ffmpeg from "ffmpeg-static";

const execute = promisify(execFile);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archive = path.resolve(process.argv[2] || path.join(repository, "release", "win-unpacked", "resources", "app.asar"));
const temporary = await mkdtemp(path.join(os.tmpdir(), "slyorrent-packaged-media-"));

try {
  const subtitlePath = path.join(temporary, "dialogues.srt");
  await writeFile(subtitlePath, "1\n00:00:00,000 --> 00:00:02,000\nSous-titres français de test\n", "utf8");
  await execute(ffmpeg, [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=880:duration=2",
    "-i", subtitlePath,
    "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0", "-map", "3:s:0",
    "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-x265-params", "pools=1:frame-threads=1:log-level=error", "-c:a", "eac3",
    "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=fre",
    "-c:s", "ass", "-metadata:s:s:0", "language=fre",
    "-t", "2", path.join(temporary, "sample.mkv"),
  ], { windowsHide: true, timeout: 30_000 });

  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = await execute(electron, [path.join(repository, "tests", "packaged-media", "runner.mjs"), archive, temporary], {
    windowsHide: true, timeout: 60_000, env: environment, maxBuffer: 512 * 1024,
  });
  process.stdout.write(result.stdout);
} catch (error) {
  process.stderr.write(String(error.stdout || error.message));
  process.exitCode = 1;
} finally {
  if (path.resolve(temporary).startsWith(`${path.resolve(os.tmpdir())}${path.sep}slyorrent-packaged-media-`)) {
    await rm(temporary, { recursive: true, force: true });
  } else {
    process.stderr.write("Dossier de test inattendu, conservé sans modification.");
    process.exitCode = 1;
  }
}
