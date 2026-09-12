const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const WINDOWS_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

export function inspectRgbaPng(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG invalide.");
  // Les PNG d'un ICO Windows doivent avoir un canal alpha, même pour une image opaque.
  if (buffer[24] !== 8 || buffer[25] !== 6) throw new Error("L'icône doit être un PNG RGBA 32 bits.");
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || width !== height || width > 4096) throw new Error("Dimensions d'icône invalides.");
  return { width, height };
}

export function inspectWindowsIco(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1 || buffer.readUInt16LE(4) !== WINDOWS_ICON_SIZES.length) throw new Error("ICO multirésolution invalide.");
  const directoryEnd = 6 + WINDOWS_ICON_SIZES.length * 16;
  if (buffer.length < directoryEnd) throw new Error("ICO tronqué.");
  const entries = [];
  let expectedOffset = directoryEnd;
  for (let index = 0; index < WINDOWS_ICON_SIZES.length; index += 1) {
    const entry = 6 + index * 16;
    const width = buffer[entry] || 256, height = buffer[entry + 1] || 256;
    const length = buffer.readUInt32LE(entry + 8), offset = buffer.readUInt32LE(entry + 12);
    if (offset !== expectedOffset || length < 33 || offset + length > buffer.length || buffer.readUInt16LE(entry + 4) !== 1 || buffer.readUInt16LE(entry + 6) !== 32) throw new Error("Image ICO invalide.");
    const png = buffer.subarray(offset, offset + length);
    const actual = inspectRgbaPng(png);
    if (width !== WINDOWS_ICON_SIZES[index] || actual.width !== width || actual.height !== height) throw new Error("Résolution ICO incohérente.");
    entries.push({ width, height, png });
    expectedOffset = offset + length;
  }
  if (expectedOffset !== buffer.length) throw new Error("Données inattendues après l'ICO.");
  return entries;
}
