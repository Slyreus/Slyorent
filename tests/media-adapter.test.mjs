import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import ffprobePath from "@derhuerst/ffprobe-static";
import test from "node:test";
import { analyzeProbe, MediaAdapter } from "../electron/media-adapter.mjs";

const execFileAsync = promisify(execFile);

test("convertir HEVC 10 bits et E-AC3 français sur CPU et avec accélération disponible", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slyorrent-hevc-test-"));
  try {
    const sourcePath = path.join(root, "hevc.mkv");
    await execFileAsync(ffmpegPath, ["-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=2", "-f", "lavfi", "-i", "sine=duration=2",
      "-map", "0:v", "-map", "1:a", "-map", "1:a", "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-x265-params", "pools=1:frame-threads=1:log-level=error",
      "-c:a", "eac3", "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=fre", "-shortest", sourcePath,
    ], { windowsHide: true, timeout: 30_000 });
    const source = await stat(sourcePath); const original = await readFile(sourcePath);
    for (const hardwareAcceleration of [false, true]) {
      const cacheDirectory = path.join(root, String(hardwareAcceleration));
      const adapter = await new MediaAdapter({ cacheDirectory, hardwareAcceleration }).initialize();
      const progress = [];
      const options = { sourcePath, sourceSize: source.size, sourceMtimeMs: source.mtimeMs, onProgress: (value) => progress.push(value) };
      const result = await adapter.prepare(options);
      assert.equal(result.videoAdapted, true); assert.equal(result.audioLanguage, "fre");
      assert.ok(progress.some((item) => item.stage === "video"));
      assert.ok(progress.some((item) => Number.isFinite(item.percent) && item.percent > 0));
      const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-show_entries", "stream=codec_name,pix_fmt,codec_type:stream_tags=language:format=duration", "-of", "json", result.filePath], { windowsHide: true, timeout: 15_000 });
      const output = JSON.parse(stdout);
      assert.equal(output.streams[0].codec_name, "h264"); assert.equal(output.streams[0].pix_fmt, "yuv420p");
      assert.equal(output.streams[1].codec_name, "aac"); assert.equal(output.streams[1].tags.language, "fre");
      assert.ok(Number(output.format.duration) >= 1.9);
      assert.equal((await adapter.prepare(options)).cacheHit, true);
      assert.equal((await readdir(cacheDirectory)).some((name) => name.endsWith(".partial")), false);
    }
    assert.deepEqual(await readFile(sourcePath), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuser un manifeste déguisé en vidéo avant toute conversion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slyorrent-media-input-"));
  try {
    const sourcePath = path.join(root, "fake.mkv");
    await writeFile(sourcePath, "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:1/segment.ts\n");
    const source = await stat(sourcePath);
    const adapter = await new MediaAdapter({ cacheDirectory: path.join(root, "cache") }).initialize();
    await assert.rejects(adapter.prepare({ sourcePath, sourceSize: source.size, sourceMtimeMs: source.mtimeMs }), { code: "MEDIA_ADAPT_FAILED" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("préparer une source HEVC HDR en H264 SDR", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "slyorrent-hdr-test-"));
  try {
    const sourcePath = path.join(root, "hdr.mkv");
    await execFileAsync(ffmpegPath, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=1",
      "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-x265-params", "pools=1:frame-threads=1:log-level=error",
      "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", sourcePath], { windowsHide: true, timeout: 30_000 });
    const source = await stat(sourcePath);
    const adapter = await new MediaAdapter({ cacheDirectory: path.join(root, "cache"), hardwareAcceleration: false }).initialize();
    const result = await adapter.prepare({ sourcePath, sourceSize: source.size, sourceMtimeMs: source.mtimeMs });
    const { stdout } = await execFileAsync(ffprobePath, ["-v", "error", "-show_entries", "stream=codec_name,pix_fmt,color_transfer,color_primaries", "-of", "json", result.filePath], { windowsHide: true, timeout: 15_000 });
    const video = JSON.parse(stdout).streams[0];
    assert.equal(video.codec_name, "h264"); assert.equal(video.pix_fmt, "yuv420p");
    assert.equal(video.color_transfer, "bt709"); assert.equal(video.color_primaries, "bt709");
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
    const options = { sourcePath, sourceSize: source.size, sourceMtimeMs: source.mtimeMs };
    const [first, concurrent] = await Promise.all([adapter.prepare(options), adapter.prepare(options)]);
    assert.equal(first.filePath, concurrent.filePath);
    assert.equal(concurrent.cacheHit, false);
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
