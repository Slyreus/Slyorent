export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

/** Garder les dialogues et leur minutage, sans styles ni ressources annexes. */
export function cleanWebVtt(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_SUBTITLE_BYTES || !value.startsWith("WEBVTT")) {
    throw Object.assign(new Error("Piste de sous-titres invalide ou trop volumineuse."), { code: "MEDIA_SUBTITLE_INVALID" });
  }
  const blocks = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split(/\n{2,}/u);
  const cues = [];
  const timestamp = /^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3} --> (?:\d{2,}:)?\d{2}:\d{2}\.\d{3}/u;
  for (const block of blocks.slice(1)) {
    const lines = block.split("\n");
    const timing = lines.findIndex((line) => timestamp.test(line));
    if (timing < 0) continue;
    const text = lines.slice(timing + 1).join("\n")
      .replace(/<[^>]*>/gu, (tag) => /^<\/?(?:b|i|u)>$/iu.test(tag) ? tag : "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trimEnd();
    if (text.trim()) cues.push(`${lines[timing].match(timestamp)[0]}\n${text}`);
    if (cues.length > 50_000) throw Object.assign(new Error("Trop de sous-titres dans cette piste."), { code: "MEDIA_SUBTITLE_INVALID" });
  }
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}
