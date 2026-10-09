import ffmpegPackagePath from "ffmpeg-static";
import ffprobePackagePath from "@derhuerst/ffprobe-static";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rename, stat, statfs, unlink } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { canonicalPathWithoutLinks, UnsafePathError } from "./safe-path.mjs";
import { resolveMediaBinaryPath } from "./media-binary-path.mjs";
import { SharedPreparations } from "./shared-preparation.mjs";
import { adaptationBudget, analyzeProbe, audioLanguage, conversionVideoArgs, localMediaInputArgs, MEDIA_CACHE_PROFILE, mediaProgressParser } from "./media-profile.mjs";
import { cleanWebVtt, MAX_SUBTITLE_BYTES } from "./subtitles.mjs";
export { analyzeProbe } from "./media-profile.mjs";

const FFMPEG_SHA256 = "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00";
const FFPROBE_SHA256 = "3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4";
const MAX_PROBE_OUTPUT = 512 * 1024;
const MAX_DIAGNOSTIC_OUTPUT = 64 * 1024;
const MAX_CACHE_BYTES = 12 * 1024 * 1024 * 1024;
const DISK_RESERVE_BYTES = 512 * 1024 * 1024;
const WORKER_THREADS = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeEnvironment() {
  return Object.fromEntries(Object.entries({
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  }).filter(([, value]) => typeof value === "string" && value.length > 0));
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifiedBinary(candidate, expectedHash, label) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error(`${label} n'est autorisé que sur Windows x64.`);
  const executable = resolveMediaBinaryPath(candidate);
  const info = await lstat(executable);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} local n'est pas un fichier régulier.`);
  let resolved;
  try {
    resolved = await canonicalPathWithoutLinks(executable);
  } catch (error) {
    if (error instanceof UnsafePathError) throw new Error(`${label} local passe par un lien interdit.`);
    throw error;
  }
  if (await sha256File(resolved) !== expectedHash) throw new Error(`L'empreinte du binaire ${label} est inattendue.`);
  return resolved;
}

function runProcess(executable, args, { timeoutMs, maxStdout = 0, maxStderr = MAX_DIAGNOSTIC_OUTPUT, signal, onStdout } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: safeEnvironment(),
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    const append = (current, chunk, maximum) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length <= maximum) return next;
      overflow = true;
      child.kill();
      return next.subarray(Math.max(0, next.length - maximum));
    };
    child.stdout.on("data", (chunk) => {
      if (!onStdout) stdout = append(stdout, chunk, maxStdout);
      else try { onStdout(chunk); } catch (error) { stoppedBy = error; child.kill(); }
    });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, maxStderr); });
    let stoppedBy = null;
    const abort = () => { stoppedBy = signal.reason; child.kill(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => {
      stoppedBy = Object.assign(new Error("La préparation du média local a dépassé le délai autorisé."), { code: "MEDIA_ADAPT_TIMEOUT" });
      child.kill();
    }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.once("error", (error) => {
      cleanup();
      reject(Object.assign(new Error("Le moteur média local n'a pas pu démarrer."), { code: "MEDIA_ADAPT_START_FAILED", cause: error }));
    });
    child.once("close", (code, exitSignal) => {
      cleanup();
      if (stoppedBy) reject(stoppedBy);
      else if (code === 0 && !overflow) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`Le moteur média local a refusé le fichier (${code ?? exitSignal ?? "inconnu"}).`), {
        code: overflow ? "MEDIA_ADAPT_OUTPUT_LIMIT" : "MEDIA_ADAPT_FAILED",
      }));
    });
  });
}

function outputCacheKey({ sourcePath, sourceSize, sourceMtimeMs, videoIndex, audioIndex }) {
  return createHash("sha256").update(JSON.stringify({
    sourcePath: path.resolve(sourcePath).toLowerCase(),
    sourceSize,
    sourceMtimeMs,
    videoIndex,
    audioIndex,
    ffmpeg: FFMPEG_SHA256,
    profile: MEDIA_CACHE_PROFILE,
  })).digest("hex");
}

export class MediaAdapter {
  #cacheDirectory;
  #ffmpeg = null;
  #ffprobe = null;
  #pending = new SharedPreparations();
  #analyses = new Map();
  #subtitleCache = new Map();
  #videoSources = new Map();
  #conversionTail = Promise.resolve();
  #protectedUntil = new Map();
  #isFileInUse;
  #hardwareAcceleration;
  #encoder = null;

  constructor({ cacheDirectory, isFileInUse = () => false, hardwareAcceleration = true }) {
    this.#cacheDirectory = path.resolve(cacheDirectory);
    this.#isFileInUse = isFileInUse;
    this.#hardwareAcceleration = hardwareAcceleration;
  }

  async initialize() {
    await mkdir(this.#cacheDirectory, { recursive: true, mode: 0o700 });
    try {
      this.#cacheDirectory = await canonicalPathWithoutLinks(this.#cacheDirectory);
    } catch (error) {
      if (error instanceof UnsafePathError) throw new Error("Le cache média local passe par un lien interdit.");
      throw error;
    }
    [this.#ffmpeg, this.#ffprobe] = await Promise.all([
      verifiedBinary(ffmpegPackagePath, FFMPEG_SHA256, "FFmpeg"),
      verifiedBinary(ffprobePackagePath, FFPROBE_SHA256, "FFprobe"),
    ]);
    return this;
  }

  async #probe(sourcePath) {
    if (!this.#ffprobe) throw new Error("Le moteur média local n'est pas initialisé.");
    const { stdout } = await runProcess(this.#ffprobe, [
      "-v", "error",
      ...localMediaInputArgs(sourcePath),
      "-show_entries", "stream=index,codec_name,codec_type,channels,channel_layout,width,height,pix_fmt,color_transfer:stream_tags=language,title:stream_disposition=default,forced,attached_pic:format=duration",
      "-of", "json",
      "--", sourcePath,
    ], { timeoutMs: 30_000, maxStdout: MAX_PROBE_OUTPUT });
    try { return JSON.parse(stdout.toString("utf8")); }
    catch { throw Object.assign(new Error("FFprobe a renvoyé des métadonnées invalides."), { code: "MEDIA_PROBE_INVALID" }); }
  }

  async #pruneCache(excludedPath, reservedBytes = 0) {
    const entries = [];
    for (const item of await readdir(this.#cacheDirectory, { withFileTypes: true })) {
      if (!item.isFile() || !/^[a-f0-9]{64}\.mp4$/u.test(item.name)) continue;
      const candidate = path.join(this.#cacheDirectory, item.name);
      if (candidate === excludedPath) continue;
      const info = await lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      entries.push({ candidate, size: info.size, mtimeMs: info.mtimeMs });
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (total + reservedBytes <= MAX_CACHE_BYTES) break;
      if (this.#isFileInUse(entry.candidate) || (this.#protectedUntil.get(entry.candidate) || 0) > Date.now()) continue;
      if (await unlink(entry.candidate).then(() => true, () => false)) total -= entry.size;
    }
    for (const [candidate, until] of this.#protectedUntil) if (until <= Date.now()) this.#protectedUntil.delete(candidate);
    return total;
  }

  async inspect({ sourcePath, sourceSize, sourceMtimeMs, audioTrack, signal, onProgress = () => undefined }) {
    signal?.throwIfAborted();
    if (!this.#ffmpeg || !this.#ffprobe) throw new Error("Le moteur média local n'est pas initialisé.");
    const resolvedSource = await canonicalPathWithoutLinks(sourcePath);
    const sourceInfo = await stat(resolvedSource);
    if (!sourceInfo.isFile() || sourceInfo.size !== sourceSize || sourceInfo.mtimeMs !== sourceMtimeMs) throw new Error("Le média a changé avant sa préparation.");
    onProgress({ stage: "probe", percent: null });
    const probeKey = JSON.stringify([resolvedSource, sourceSize, sourceMtimeMs]);
    if (!this.#analyses.has(probeKey)) {
      const probe = this.#probe(resolvedSource).catch((error) => { this.#analyses.delete(probeKey); throw error; });
      this.#analyses.set(probeKey, probe);
      while (this.#analyses.size > 128) this.#analyses.delete(this.#analyses.keys().next().value);
    }
    const analysis = analyzeProbe(await this.#analyses.get(probeKey), { audioTrack });
    signal?.throwIfAborted();
    return { ...analysis, sourcePath: resolvedSource };
  }

  async extractSubtitle({ trackIndex, ...options }) {
    const analysis = await this.inspect(options);
    const track = analysis.subtitleTracks.find((item) => item.index === trackIndex);
    if (!Number.isInteger(trackIndex) || !track) throw Object.assign(new Error("Piste de sous-titres introuvable."), { code: "MEDIA_SUBTITLE_TRACK_INVALID" });
    if (!track.supported) throw Object.assign(new Error("Le format de cette piste de sous-titres n'est pas pris en charge."), { code: "MEDIA_SUBTITLE_UNSUPPORTED" });
    const key = JSON.stringify([analysis.sourcePath, options.sourceSize, options.sourceMtimeMs, trackIndex]);
    if (this.#subtitleCache.has(key)) return this.#subtitleCache.get(key);
    return this.#pending.run(`subtitle:${key}`, options.signal, async (signal, report) => {
      report({ stage: "subtitles", percent: null });
      const { stdout } = await runProcess(this.#ffmpeg, [
        "-nostdin", "-hide_banner", "-loglevel", "error", ...localMediaInputArgs(analysis.sourcePath),
        "-i", analysis.sourcePath, "-map", `0:${trackIndex}`, "-vn", "-an", "-dn", "-map_metadata", "-1",
        "-c:s", "webvtt", "-f", "webvtt", "pipe:1",
      ], { timeoutMs: 60_000, maxStdout: MAX_SUBTITLE_BYTES, signal });
      const after = await stat(analysis.sourcePath);
      if (after.size !== options.sourceSize || after.mtimeMs !== options.sourceMtimeMs) throw new Error("Le média a changé pendant la lecture des sous-titres.");
      const vtt = cleanWebVtt(stdout.toString("utf8"));
      this.#subtitleCache.set(key, vtt);
      while (this.#subtitleCache.size > 8) this.#subtitleCache.delete(this.#subtitleCache.keys().next().value);
      return vtt;
    }, options.onProgress);
  }

  async prepare({ sourcePath, sourceSize, sourceMtimeMs, audioTrack, signal, onProgress = () => undefined }) {
    const analysis = await this.inspect({ sourcePath, sourceSize, sourceMtimeMs, audioTrack, signal, onProgress });
    const resolvedSource = analysis.sourcePath;
    if (!analysis.needsAdaptation) return null;
    adaptationBudget(analysis, sourceSize);
    const key = outputCacheKey({
      sourcePath: resolvedSource,
      sourceSize,
      sourceMtimeMs,
      videoIndex: analysis.video.index,
      audioIndex: analysis.audio?.index ?? null,
    });
    const outputPath = path.join(this.#cacheDirectory, `${key}.mp4`);
    if (!containsPath(this.#cacheDirectory, outputPath)) throw new Error("Chemin de cache média invalide.");
    return this.#pending.run(key, signal, (sharedSignal, report) => this.#prepareOnce({
      resolvedSource,
      outputPath,
      sourceSize,
      sourceMtimeMs,
      analysis,
      onProgress: report,
      signal: sharedSignal,
    }).then((result) => {
      // Protéger aussi le fichier pendant l'analyse Defender, avant l'émission du jeton.
      this.#protectedUntil.set(result.filePath, Date.now() + 10 * 60_000);
      if (analysis.videoAdapted) {
        const videoKey = JSON.stringify([resolvedSource, sourceSize, sourceMtimeMs, analysis.video.index]);
        this.#videoSources.set(videoKey, result);
        while (this.#videoSources.size > 128) this.#videoSources.delete(this.#videoSources.keys().next().value);
      }
      return result;
    }), onProgress);
  }

  #result(outputPath, info, analysis, cacheHit) {
    return {
      filePath: outputPath, size: info.size, mtimeMs: info.mtimeMs, mimeType: "video/mp4",
      audioAdapted: Boolean(analysis.audio), audioCodec: analysis.audio ? "AAC" : null,
      audioLanguage: analysis.audio ? audioLanguage(analysis.audio) : null,
      videoAdapted: analysis.videoAdapted, videoCodec: analysis.videoAdapted ? "H264" : String(analysis.video.codec_name).toUpperCase(), cacheHit,
    };
  }

  async #prepareOnce({ resolvedSource, outputPath, sourceSize, sourceMtimeMs, analysis, signal, onProgress }) {
    signal.throwIfAborted();
    const cached = await lstat(outputPath).catch(() => null);
    if (cached) {
      if (!cached.isFile() || cached.isSymbolicLink() || cached.size <= 0) throw new Error("Le cache média local est invalide.");
      return this.#result(outputPath, cached, analysis, true);
    }

    onProgress({ stage: "queued", percent: null });
    const task = this.#conversionTail.then(() => this.#convert({ resolvedSource, outputPath, sourceSize, sourceMtimeMs, analysis, signal, onProgress }));
    this.#conversionTail = task.catch(() => undefined);
    return task;
  }

  async #preferredEncoder() {
    if (!this.#hardwareAcceleration) return "libx264";
    if (!this.#encoder) this.#encoder = runProcess(this.#ffmpeg, [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=s=320x180:d=0.05",
      "-frames:v", "1", "-c:v", "h264_nvenc", "-pix_fmt", "yuv420p", "-f", "null", "-",
    ], { timeoutMs: 10_000 }).then(() => "h264_nvenc", () => "libx264");
    return this.#encoder;
  }

  async #convert({ resolvedSource, outputPath, sourceSize, sourceMtimeMs, analysis, signal, onProgress }) {
    signal.throwIfAborted();
    const { reservedBytes } = adaptationBudget(analysis, sourceSize);
    if (reservedBytes > MAX_CACHE_BYTES) throw Object.assign(new Error("Cette conversion dépasse les 12 Go du cache média."), { code: "MEDIA_ADAPT_CACHE_LIMIT" });
    const retainedBytes = await this.#pruneCache(outputPath, reservedBytes);
    if (retainedBytes + reservedBytes > MAX_CACHE_BYTES) throw Object.assign(new Error("Cache média occupé. Fermez les autres lecteurs puis réessayez."), { code: "MEDIA_ADAPT_CACHE_BUSY" });
    const disk = await statfs(this.#cacheDirectory);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes < reservedBytes + DISK_RESERVE_BYTES) {
      throw Object.assign(new Error("Espace disque insuffisant pour préparer la lecture locale."), { code: "MEDIA_ADAPT_NO_SPACE" });
    }
    const outputLimit = Math.floor(Math.min(MAX_CACHE_BYTES - retainedBytes, freeBytes - DISK_RESERVE_BYTES));
    const tempPath = path.join(this.#cacheDirectory, `${randomUUID()}.partial`);
    const videoKey = JSON.stringify([resolvedSource, sourceSize, sourceMtimeMs, analysis.video.index]);
    const previousVideo = analysis.videoAdapted ? this.#videoSources.get(videoKey) : null;
    const previousInfo = previousVideo ? await lstat(previousVideo.filePath).catch(() => null) : null;
    const reuseVideo = previousInfo?.isFile() && !previousInfo.isSymbolicLink()
      && previousInfo.size === previousVideo.size && previousInfo.mtimeMs === previousVideo.mtimeMs
      && containsPath(this.#cacheDirectory, previousVideo.filePath) ? previousVideo : null;
    try {
      const convert = async (encoder) => {
        const stage = analysis.videoAdapted && !reuseVideo ? "video" : "audio";
        const hardware = analysis.videoAdapted && !reuseVideo && encoder === "h264_nvenc";
        onProgress({ stage, percent: 0, hardware });
        await runProcess(this.#ffmpeg, [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-nostats", "-progress", "pipe:1", "-stats_period", "0.5",
          ...localMediaInputArgs(resolvedSource), "-threads", String(WORKER_THREADS), "-filter_threads", "2", "-i", resolvedSource,
          ...(reuseVideo ? [...localMediaInputArgs(reuseVideo.filePath), "-i", reuseVideo.filePath] : []),
          "-map", reuseVideo ? "1:v:0" : `0:${analysis.video.index}`, ...(analysis.audio ? ["-map", `0:${analysis.audio.index}`] : []),
          "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn",
          ...(reuseVideo ? ["-c:v", "copy"] : conversionVideoArgs(analysis, encoder, WORKER_THREADS)),
          ...(analysis.audio ? ["-c:a", "aac", "-ac", "2", "-b:a", "192k", "-metadata:s:a:0", `language=${audioLanguage(analysis.audio)}`] : ["-an"]),
          "-fs", String(outputLimit), "-movflags", "+faststart", "-f", "mp4", tempPath,
        ], { timeoutMs: 2 * 60 * 60_000, signal, onStdout: mediaProgressParser(analysis.duration, ({ percent, finalizing }) => onProgress({ stage: finalizing ? "finalizing" : stage, percent, hardware })) });
      };
      const encoder = analysis.videoAdapted && !reuseVideo ? await this.#preferredEncoder() : "libx264";
      try { await convert(encoder); }
      catch (error) {
        if (encoder !== "h264_nvenc" || signal.aborted || error.code !== "MEDIA_ADAPT_FAILED") throw error;
        this.#encoder = Promise.resolve("libx264");
        await convert("libx264");
      }
      signal.throwIfAborted();
      const sourceAfter = await stat(resolvedSource);
      if (sourceAfter.size !== sourceSize || sourceAfter.mtimeMs !== sourceMtimeMs) throw new Error("Le média source a changé pendant sa préparation.");
      if (reuseVideo) {
        const after = await stat(reuseVideo.filePath);
        if (after.size !== reuseVideo.size || after.mtimeMs !== reuseVideo.mtimeMs) throw new Error("La copie vidéo a changé pendant la préparation du son.");
      }
      const tempInfo = await lstat(tempPath);
      if (!tempInfo.isFile() || tempInfo.isSymbolicLink() || tempInfo.size <= 0) throw new Error("La version compatible n'a pas été produite.");
      if (tempInfo.size >= outputLimit - 1024 * 1024) throw Object.assign(new Error("La conversion a atteint la limite du cache."), { code: "MEDIA_ADAPT_CACHE_LIMIT" });
      // Refuser une sortie tronquée même si FFmpeg s'est terminé sans erreur.
      const { stdout } = await runProcess(this.#ffprobe, ["-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov", "-show_entries", "format=duration", "-of", "json", "--", tempPath], { timeoutMs: 30_000, maxStdout: MAX_PROBE_OUTPUT, signal });
      const outputDuration = Number(JSON.parse(stdout.toString("utf8"))?.format?.duration);
      if (!Number.isFinite(outputDuration) || outputDuration < analysis.duration - 0.5) throw Object.assign(new Error("La conversion vidéo est incomplète."), { code: "MEDIA_ADAPT_INCOMPLETE" });
      await rename(tempPath, outputPath);
      const outputInfo = await stat(outputPath);
      return this.#result(outputPath, outputInfo, analysis, false);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}
