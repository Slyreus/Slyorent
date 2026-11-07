import path from "node:path";
import { fileURLToPath } from "node:url";

export const MEDIA_VERSION = "9.0.2";
export const MEDIA_SHA256 = Object.freeze({
  ffmpeg: "3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec",
  ffprobe: "f0d36ecbbdd3bcfac3efa078c96c7271c2e68b3810595552ac3b7f17e9a65c52",
});
export function mediaPathsForApp(applicationDirectory = fileURLToPath(new URL("../", import.meta.url))) {
  const application = path.resolve(applicationDirectory);
  const root = path.basename(application).toLowerCase() === "app.asar" ? path.dirname(application) : application;
  const directory = path.join(root, ".runtime", "media", `ffmpeg-${MEDIA_VERSION}`);
  return { ffmpeg: path.join(directory, "ffmpeg.exe"), ffprobe: path.join(directory, "ffprobe.exe") };
}
export const { ffmpeg: ffmpegPath, ffprobe: ffprobePath } = mediaPathsForApp();
