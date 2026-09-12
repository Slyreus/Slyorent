export const LIBRARY_DEFAULTS = Object.freeze({ view: "titles", groupBy: "title", sort: "title", descending: false, favorites: [] });
const options = { view: ["titles", "list"], groupBy: ["title", "torrent", "none"], sort: ["title", "added", "watched", "size"] };
export function validLibraryKey(key) { return typeof key === "string" && /^(series|movie|audio):[^\u0000-\u001f\u007f]{1,350}$/u.test(key); }
export function normalizeLibraryPreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Préférences de médiathèque invalides.");
  const result = { ...LIBRARY_DEFAULTS, favorites: [] };
  for (const key of Object.keys(options)) {
    if (!options[key].includes(value[key])) throw new Error("Choix de médiathèque invalide.");
    result[key] = value[key];
  }
  if (typeof value.descending !== "boolean" || !Array.isArray(value.favorites) || value.favorites.length > 2000 || !value.favorites.every(validLibraryKey)) throw new Error("Préférences de médiathèque invalides.");
  result.descending = value.descending;
  if (result.view === "titles" && result.groupBy === "none") result.groupBy = "title";
  result.favorites = [...new Set(value.favorites)];
  if (new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, preferences: result })).byteLength > 1024 * 1024) throw new Error("La liste des favoris est trop volumineuse.");
  return result;
}
