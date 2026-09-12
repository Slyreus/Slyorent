export type LibraryPreferences = {
  view: "titles" | "list";
  groupBy: "title" | "torrent" | "none";
  sort: "title" | "added" | "watched" | "size";
  descending: boolean;
  favorites: string[];
};
export type LibraryPreferencePatch = Partial<Omit<LibraryPreferences, "favorites">> & { favorite?: { key: string; value: boolean } };
export const LIBRARY_DEFAULTS: Readonly<LibraryPreferences>;
export function validLibraryKey(key: unknown): boolean;
export function normalizeLibraryPreferences(value: unknown): LibraryPreferences;
