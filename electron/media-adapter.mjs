import ffmpegPackagePath from "ffmpeg-static";
import ffprobePackagePath from "@derhuerst/ffprobe-static";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, stat, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { canonicalPathWithoutLinks, UnsafePathError } from "./safe-path.mjs";
import { SharedPreparations } from "./shared-preparation.mjs";

const FFMPEG_SHA256 = "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00";
const FFPROBE_SHA256 = "3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4";
const MAX_PROBE_OUTPUT = 512 * 1024;
const MAX_DIAGNOSTIC_OUTPUT = 64 * 1024;
const MAX_CACHE_BYTES = 12 * 1024 * 1024 * 1024;
const AUDIO_REQUIRING_ADAPTATION = new Set(["ac3", "eac3", "dca", "dts", "truehd"]);
const MP4_COPY_VIDEO_CODECS = new Set(["h264", "av1", "mpeg4"]);
const FRENCH_LANGUAGE_CODES = new Set(["fr", "fre", "fra", "french"]);

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
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) throw new Error(`${label} local est introuvable.`);
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} local n'est pas un fichier régulier.`);
  let resolved;
  try {
    resolved = await canonicalPathWithoutLinks(candidate);
  } catch (error) {
    if (error instanceof UnsafePathError) throw new Error(`${label} local passe par un lien interdit.`);
    throw error;
  }
  if (await sha256File(resolved) !== expectedHash) throw new Error(`L'empreinte du binaire ${label} est inattendue.`);
  return resolved;
}

function runProcess(executable, args, { timeoutMs, maxStdout = 0, maxStderr = MAX_DIAGNOSTIC_OUTPUT, signal } = {}) {
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
      return next.subarray(Math.max(0, next.length - maximum));
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk, maxStdout); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, maxStderr); });
    let stoppedBy = null;
    const abort = () => { stoppedBy = signal.reason; child.kill(); };
    signal?.addEventListener("abort", abort, { once: true });
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

function normalizedLanguage(stream) {
  return String(stream?.tags?.language || "").trim().toLowerCase();
}

function selectAudioStream(streams) {
  const audio = streams.filter((stream) => stream?.codec_type === "audio" && Number.isInteger(stream.index));
  return audio.find((stream) => FRENCH_LANGUAGE_CODES.has(normalizedLanguage(stream))) ?? audio[0] ?? null;
}

function selectVideoStream(streams) {
  return streams.find((stream) => stream?.codec_type === "video" && Number.isInteger(stream.index)) ?? null;
}

function outputCacheKey({ sourcePath, sourceSize, sourceMtimeMs, videoIndex, audioIndex }) {
  return createHash("sha256").update(JSON.stringify({
    sourcePath: path.resolve(sourcePath).toLowerCase(),
    sourceSize,
    sourceMtimeMs,
    videoIndex,
    audioIndex,
    ffmpeg: FFMPEG_SHA256,
    profile: "h264-copy-aac-stereo-v1",
  })).digest("hex");
}

export function analyzeProbe(probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = selectVideoStream(streams);
  const audio = selectAudioStream(streams);
  if (!video || !audio) return { needsAdaptation: false, video, audio };
  return {
    needsAdaptation: AUDIO_REQUIRING_ADAPTATION.has(String(audio.codec_name || "").toLowerCase()),
    video,
    audio,
  };
}

export class MediaAdapter {
  #cacheDirectory;
  #ffmpeg = null;
  #ffprobe = null;
  #pending = new SharedPreparations();
  #analyses = new Map();
  #conversionTail = Promise.resolve();
  #protectedUntil = new Map();
  #isFileInUse;

  constructor({ cacheDirectory, isFileInUse = () => false }) {
    this.#cacheDirectory = path.resolve(cacheDirectory);
    this.#isFileInUse = isFileInUse;
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
      "-show_entries", "stream=index,codec_name,codec_type,channels,channel_layout:stream_tags=language,title",
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
      await unlink(entry.candidate).catch(() => undefined);
      total -= entry.size;
    }
    for (const [candidate, until] of this.#protectedUntil) if (until <= Date.now()) this.#protectedUntil.delete(candidate);
  }

  async prepare({ sourcePath, sourceSize, sourceMtimeMs, signal }) {
    signal?.throwIfAborted();
    if (!this.#ffmpeg || !this.#ffprobe) throw new Error("Le moteur média local n'est pas initialisé.");
    const resolvedSource = await realpath(sourcePath);
    const sourceInfo = await stat(resolvedSource);
    if (!sourceInfo.isFile() || sourceInfo.size !== sourceSize || sourceInfo.mtimeMs !== sourceMtimeMs) throw new Error("Le média a changé avant sa préparation audio.");
    const probeKey = JSON.stringify([resolvedSource, sourceSize, sourceMtimeMs]);
    if (!this.#analyses.has(probeKey)) {
      const probe = this.#probe(resolvedSource).then(analyzeProbe).catch((error) => { this.#analyses.delete(probeKey); throw error; });
      this.#analyses.set(probeKey, probe);
      while (this.#analyses.size > 128) this.#analyses.delete(this.#analyses.keys().next().value);
    }
    const analysis = await this.#analyses.get(probeKey);
    signal?.throwIfAborted();
    if (!analysis.needsAdaptation) return null;
    if (!MP4_COPY_VIDEO_CODECS.has(String(analysis.video.codec_name || "").toLowerCase())) {
      throw Object.assign(new Error(`Le son ${String(analysis.audio.codec_name || "").toUpperCase()} est détecté, mais la vidéo ${String(analysis.video.codec_name || "").toUpperCase()} ne peut pas être adaptée sans réencodage complet.`), { code: "MEDIA_VIDEO_CODEC_UNSUPPORTED" });
    }
    const key = outputCacheKey({
      sourcePath: resolvedSource,
      sourceSize,
      sourceMtimeMs,
      videoIndex: analysis.video.index,
      audioIndex: analysis.audio.index,
    });
    const outputPath = path.join(this.#cacheDirectory, `${key}.mp4`);
    if (!containsPath(this.#cacheDirectory, outputPath)) throw new Error("Chemin de cache média invalide.");
    return this.#pending.run(key, signal, (sharedSignal) => this.#prepareOnce({
      resolvedSource,
      outputPath,
      sourceSize,
      sourceMtimeMs,
      video: analysis.video,
      audio: analysis.audio,
      signal: sharedSignal,
    }).then((result) => {
      // Protéger aussi le fichier pendant l'analyse Defender, avant l'émission du jeton.
      this.#protectedUntil.set(result.filePath, Date.now() + 10 * 60_000);
      return result;
    }));
  }

  async #prepareOnce({ resolvedSource, outputPath, sourceSize, sourceMtimeMs, video, audio, signal }) {
    signal.throwIfAborted();
    const cached = await lstat(outputPath).catch(() => null);
    if (cached) {
      if (!cached.isFile() || cached.isSymbolicLink() || cached.size <= 0) throw new Error("Le cache audio local est invalide.");
      return {
        filePath: outputPath,
        size: cached.size,
        mtimeMs: cached.mtimeMs,
        mimeType: "video/mp4",
        audioAdapted: true,
        audioCodec: "AAC",
        audioLanguage: normalizedLanguage(audio) || "und",
        cacheHit: true,
      };
    }

    const task = this.#conversionTail.then(() => this.#convert({ resolvedSource, outputPath, sourceSize, sourceMtimeMs, video, audio, signal }));
    this.#conversionTail = task.catch(() => undefined);
    return task;
  }

  async #convert({ resolvedSource, outputPath, sourceSize, sourceMtimeMs, video, audio, signal }) {
    signal.throwIfAborted();
    await this.#pruneCache(outputPath, sourceSize);
    const disk = await statfs(this.#cacheDirectory);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes < sourceSize + 512 * 1024 * 1024) {
      throw Object.assign(new Error("Espace disque insuffisant pour préparer une version locale avec audio compatible."), { code: "MEDIA_ADAPT_NO_SPACE" });
    }
    const tempPath = path.join(this.#cacheDirectory, `${randomUUID()}.partial`);
    try {
      await runProcess(this.#ffmpeg, [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-i", resolvedSource,
        "-map", `0:${video.index}`,
        "-map", `0:${audio.index}`,
        "-map_metadata", "-1",
        "-map_chapters", "-1",
        "-c:v", "copy",
        "-c:a", "aac",
        "-ac", "2",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-f", "mp4",
        tempPath,
      ], { timeoutMs: 60 * 60_000, maxStdout: 0, signal });
      signal.throwIfAborted();
      const sourceAfter = await stat(resolvedSource);
      if (sourceAfter.size !== sourceSize || sourceAfter.mtimeMs !== sourceMtimeMs) throw new Error("Le média source a changé pendant sa préparation audio.");
      const tempInfo = await lstat(tempPath);
      if (!tempInfo.isFile() || tempInfo.isSymbolicLink() || tempInfo.size <= 0) throw new Error("La version audio compatible n'a pas été produite.");
      await rename(tempPath, outputPath);
      const outputInfo = await stat(outputPath);
      return {
        filePath: outputPath,
        size: outputInfo.size,
        mtimeMs: outputInfo.mtimeMs,
        mimeType: "video/mp4",
        audioAdapted: true,
        audioCodec: "AAC",
        audioLanguage: normalizedLanguage(audio) || "und",
        cacheHit: false,
      };
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}
