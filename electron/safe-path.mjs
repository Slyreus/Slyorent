import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export class UnsafePathError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "UnsafePathError";
    this.code = code;
  }
}

export async function canonicalPathWithoutLinks(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0") || !path.isAbsolute(candidate)) {
    throw new UnsafePathError("Chemin local invalide.", "INVALID_LOCAL_PATH");
  }
  const requested = path.resolve(candidate);
  const root = path.parse(requested).root;
  let current = root;
  const segments = path.relative(root, requested).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new UnsafePathError("Le chemin local passe par un lien ou un point de jonction.", "SYMBOLIC_PATH_COMPONENT");
    }
  }
  return realpath(requested);
}
