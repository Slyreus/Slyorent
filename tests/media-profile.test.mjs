import assert from "node:assert/strict";
import test from "node:test";
import { adaptationBudget, analyzeProbe, conversionVideoArgs, localMediaInputArgs, mediaProgressParser } from "../electron/media-profile.mjs";

const probe = (codec = "hevc", audio = "eac3") => ({ format: { duration: "120" }, streams: [
  { index: 0, codec_type: "video", codec_name: "png", disposition: { attached_pic: 1 } },
  { index: 1, codec_type: "video", codec_name: codec, pix_fmt: "yuv420p10le", width: 1920, height: 1080 },
  { index: 2, codec_type: "audio", codec_name: audio, disposition: { default: 1 }, tags: { language: "eng" } },
  { index: 3, codec_type: "audio", codec_name: audio, tags: { language: "fre" } },
] });

test("convertir HEVC 10 bits et sélectionner le français sans prendre l'affiche pour la vidéo", () => {
  const result = analyzeProbe(probe());
  assert.equal(result.video.index, 1); assert.equal(result.audio.index, 3);
  assert.equal(result.needsAdaptation, true); assert.equal(result.videoAdapted, true);
  const args = conversionVideoArgs(result, "libx264", 4);
  assert.ok(args.includes("libx264")); assert.ok(args.includes("yuv420p"));
  assert.ok(adaptationBudget(result, 1000).reservedBytes > 1000);
});

test("préparer aussi HEVC avec AAC, HEVC sans son et H264 10 bits", () => {
  for (const value of [probe("hevc", "aac"), probe("h264", "aac"), { ...probe(), streams: probe().streams.slice(0, 2) }]) {
    assert.equal(analyzeProbe(value).videoAdapted, true);
    assert.equal(analyzeProbe(value).needsAdaptation, true);
  }
});

test("ne pas réencoder une vidéo H264 compatible et garder la piste française AAC", () => {
  const value = probe("h264", "aac"); value.streams[1].pix_fmt = "yuv420p";
  const result = analyzeProbe(value);
  assert.equal(result.needsAdaptation, true); assert.equal(result.videoAdapted, false);
  assert.deepEqual(conversionVideoArgs(result, "libx264", 4), ["-c:v", "copy"]);
  value.streams.splice(2, 1);
  assert.equal(analyzeProbe(value).needsAdaptation, false);
});

test("limiter les entrées aux conteneurs locaux et refuser les listes distantes", () => {
  assert.deepEqual(localMediaInputArgs("video.mkv"), ["-protocol_whitelist", "file", "-format_whitelist", "matroska,webm"]);
  assert.equal(localMediaInputArgs("video.MP4").at(-1), "mov");
  for (const name of ["list.m3u8", "files.ffconcat", "movie.sdp", "movie.txt"]) assert.throws(() => localMediaInputArgs(name), /non autorisé/);
});

test("borner les durées, les dimensions et la progression reçue de FFmpeg", () => {
  const result = analyzeProbe(probe());
  assert.throws(() => adaptationBudget({ ...result, duration: Infinity }, 1000), /Durée/);
  assert.throws(() => adaptationBudget({ ...result, duration: 0 }, 1000), /Durée/);
  assert.throws(() => adaptationBudget({ ...result, video: { ...result.video, width: 100000 } }, 1000), /Dimensions/);
  const reports = []; const parse = mediaProgressParser(10, (value) => reports.push(value));
  parse(Buffer.from("out_time_u")); parse(Buffer.from("s=5000000\nprogress=continue\n"));
  parse(Buffer.from("out_time_us=11000000\nprogress=end\n"));
  assert.deepEqual(reports, [{ percent: 50, finalizing: false }, { percent: 99, finalizing: true }]);
  assert.throws(() => parse(Buffer.alloc(8193)), /invalide/);
});

test("convertir HDR en SDR uniquement pour les sources HDR", () => {
  const result = analyzeProbe(probe());
  assert.ok(!conversionVideoArgs(result, "libx264", 4).join(" ").includes("tonemap="));
  result.video.color_transfer = "smpte2084";
  assert.ok(conversionVideoArgs(result, "libx264", 4).join(" ").includes("tonemap=tonemap=hable"));
});
