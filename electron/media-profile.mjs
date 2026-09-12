import path from "node:path";

const FRENCH = new Set(["fr", "fre", "fra", "french"]);
const AUDIO_TO_CONVERT = new Set(["ac3", "eac3", "dca", "dts", "truehd", "mlp"]);
const NATIVE_VIDEO = new Set(["h264", "av1", "vp8", "vp9"]);
const COPY_TO_MP4 = new Set(["h264", "av1"]);
const INPUT_FORMATS = new Map([
  [".mkv", "matroska,webm"], [".webm", "matroska,webm"],
  [".mp4", "mov"], [".m4v", "mov"], [".m4a", "mov"],
]);

export const MEDIA_CACHE_PROFILE = "compatible-mp4-v2";
export const audioLanguage = (stream) => String(stream?.tags?.language || "und").trim().toLowerCase();

export function localMediaInputArgs(sourcePath) {
  const format = INPUT_FORMATS.get(path.extname(sourcePath).toLowerCase());
  if (!format) throw Object.assign(new Error("Format non autorisé pour la préparation locale."), { code: "MEDIA_INPUT_FORMAT" });
  // Aucun manifeste, protocole distant ou lecteur de listes de fichiers.
  return ["-protocol_whitelist", "file", "-format_whitelist", format];
}

export function analyzeProbe(probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream?.codec_type === "video" && Number.isInteger(stream.index) && !stream.disposition?.attached_pic) ?? null;
  const audioStreams = streams.filter((stream) => stream?.codec_type === "audio" && Number.isInteger(stream.index));
  const defaultAudio = audioStreams.find((stream) => stream.disposition?.default) ?? audioStreams[0] ?? null;
  const audio = audioStreams.find((stream) => FRENCH.has(audioLanguage(stream))) ?? defaultAudio;
  const codec = String(video?.codec_name || "").toLowerCase();
  let videoAdapted = Boolean(video && (!NATIVE_VIDEO.has(codec) || (codec === "h264" && /(?:p10|p12|p16|444|422)/u.test(video.pix_fmt || ""))));
  const audioNeedsConversion = Boolean(audio && AUDIO_TO_CONVERT.has(String(audio.codec_name || "").toLowerCase()));
  const selectFrench = Boolean(audio && defaultAudio && audio.index !== defaultAudio.index);
  const needsAdaptation = Boolean(video && (videoAdapted || audioNeedsConversion || selectFrench));
  if (needsAdaptation && !COPY_TO_MP4.has(codec)) videoAdapted = true;
  const seconds = Number(probe?.format?.duration);
  return { video, audio, needsAdaptation, videoAdapted, duration: Number.isFinite(seconds) && seconds > 0 ? seconds : 0 };
}

export function adaptationBudget(analysis, sourceSize) {
  if (!analysis.duration || analysis.duration > 24 * 60 * 60) throw Object.assign(new Error("Durée du média absente ou hors limite."), { code: "MEDIA_DURATION_INVALID" });
  const width = Number(analysis.video?.width), height = Number(analysis.video?.height);
  if (analysis.videoAdapted && (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 7680) || width * height > 7680 * 4320)) throw Object.assign(new Error("Dimensions vidéo hors limite."), { code: "MEDIA_DIMENSIONS_INVALID" });
  const maxRate = width * height > 1920 * 1080 ? 30_000_000 : 12_000_000;
  const reservedBytes = Math.ceil(analysis.videoAdapted
    ? analysis.duration * (maxRate + 192_000) / 8 * 1.05 + 8 * 1024 * 1024
    : sourceSize + analysis.duration * 192_000 / 8 + 8 * 1024 * 1024);
  return { maxRate, reservedBytes };
}

export function conversionVideoArgs(analysis, encoder, threads) {
  if (!analysis.videoAdapted) return ["-c:v", "copy"];
  const { maxRate } = adaptationBudget(analysis, 0);
  const hdr = ["smpte2084", "arib-std-b67"].includes(analysis.video.color_transfer);
  const filters = hdr
    ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"
    : "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p";
  return ["-c:v", encoder, ...(encoder === "h264_nvenc"
    ? ["-preset", "p4", "-rc", "vbr", "-cq", "20", "-b:v", "0"]
    : ["-preset", "veryfast", "-crf", "20", "-threads", String(threads)]),
  "-maxrate", String(maxRate), "-bufsize", String(maxRate * 2), "-vf", filters,
  "-pix_fmt", "yuv420p", ...(hdr ? ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"] : [])];
}

export function mediaProgressParser(duration, report) {
  let pending = "", seconds = 0;
  return (chunk) => {
    pending += chunk.toString("utf8");
    if (pending.length > 8192) throw Object.assign(new Error("Progression média invalide."), { code: "MEDIA_PROGRESS_INVALID" });
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
      const [key, value] = line.split("=", 2);
      if (key === "out_time_us" && /^\d+$/u.test(value)) seconds = Number(value) / 1_000_000;
      if (key === "progress") report({ percent: Math.max(0, Math.min(99, Math.floor(seconds / duration * 100))), finalizing: value === "end" });
    }
  };
}
