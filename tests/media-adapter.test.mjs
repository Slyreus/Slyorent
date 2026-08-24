import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "@derhuerst/ffprobe-static";
import test from "node:test";
import { analyzeProbe, MediaAdapter } from "../electron/media-adapter.mjs";

const execFileAsync = promisify(execFile);

test("la piste française AC3 est choisie pour l'adaptation audio", () => {
  const result = analyzeProbe({ streams: [
    { index: 0, codec_type: "audio", codec_name: "ac3", tags: { language: "eng" } },
    { index: 1, codec_type: "video", codec_name: "h264" },
    { index: 2, codec_type: "audio", codec_name: "ac3", tags: { language: "fre" } },
  ] });
  assert.equal(result.needsAdaptation, true);
  assert.equal(result.video.index, 1);
  assert.equal(result.audio.index, 2);
});

test("un média synthétique AC3 devient un MP4 H264/AAC réutilisable", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "secutorrent-media-adapter-"));
  try {
    const sourcePath = path.join(root, "source.mkv");
    const cacheDirectory = path.join(root, "cache");
    await execFileAsync(ffmpegPath, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0x08233d:s=320x180:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=1",
      "-map", "0:v:0", "-map", "1:a:0", "-map", "2:a:0",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "ac3", "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=fre",
      "-shortest", sourcePath,
    ], { windowsHide: true, timeout: 30_000 });

    const source = await stat(sourcePath);
    const adapter = await new MediaAdapter({ cacheDirectory }).initialize();
    const first = await adapter.prepare({ sourcePath, sourceSize: source.size, sourceMtimeMs: source.mtimeMs });
    assert.equal(first.audioAdapted, true);
    assert.equal(first.audioCodec, "AAC");
    assert.equal(first.audioLanguage, "fre");
    assert.equal(first.mimeType, "video/mp4");
    assert.equal(first.cacheHit, false);

    const { stdout } = await execFileAsync(ffprobePath, [
      "-v", "error", "-show_entries", "stream=codec_name,codec_type", "-of", "json", "--", first.filePath,
    ], { windowsHide: true, timeout: 30_000 });
    const streams = JSON.parse(stdout).streams;
    assert.equal(streams.some((stream) => stream.codec_type === "video" && stream.codec_name === "h264"), true);
    assert.equal(streams.some((stream) => stream.codec_type === "audio" && stream.codec_name === "aac"), true);

    const second = await adapter.prepare({ sourcePath, sourceSize: source.size, sourceMtimeMs: source.mtimeMs });
    assert.equal(second.filePath, first.filePath);
    assert.equal(second.cacheHit, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
