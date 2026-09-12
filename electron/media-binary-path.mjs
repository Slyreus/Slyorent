import path from "node:path";
import { fileURLToPath } from "node:url";

const APPLICATION_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));

function isInside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function resolveMediaBinaryPath(candidate, applicationDirectory = APPLICATION_DIRECTORY) {
  if (typeof candidate !== "string" || candidate.includes("\0") || !path.isAbsolute(candidate)) {
    throw new Error("Chemin du moteur média local invalide.");
  }
  const application = path.resolve(applicationDirectory);
  const executable = path.resolve(candidate);
  const packaged = path.basename(application).toLowerCase() === "app.asar";
  const unpacked = `${application}.unpacked`;

  if (packaged && isInside(unpacked, executable)) return executable;
  if (!isInside(application, executable)) throw new Error("Le moteur média doit être fourni avec l'application.");

  // spawn ne peut pas exécuter un fichier virtuel dans ASAR. Vérifier ensuite
  // le fichier physique dépaqueté, sans recherche dans le PATH ni téléchargement.
  return packaged ? path.join(unpacked, path.relative(application, executable)) : executable;
}
