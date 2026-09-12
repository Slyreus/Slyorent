import { createRoot } from "react-dom/client";
import { MediaLibraryView, type MediaBridge } from "../../app/components/MediaLibrary";

declare global { interface Window { mediaTest: { invoke: (method: string, params?: object) => Promise<unknown> } } }
const invoke = window.mediaTest.invoke;
const bridge: MediaBridge = {
  openMedia: (options) => invoke("openMedia", options) as ReturnType<MediaBridge["openMedia"]>,
  renewMedia: (url) => invoke("renewMedia", { url }) as ReturnType<MediaBridge["renewMedia"]>,
  releaseMedia: (url) => invoke("releaseMedia", { url }) as ReturnType<MediaBridge["releaseMedia"]>,
  cancelMediaPreparation: (requestId) => invoke("cancelMediaPreparation", { requestId }) as ReturnType<MediaBridge["cancelMediaPreparation"]>,
  mediaPreparation: (requestId) => invoke("mediaPreparation", { requestId }) as ReturnType<MediaBridge["mediaPreparation"]>,
  watchHistory: () => invoke("watchHistory") as ReturnType<MediaBridge["watchHistory"]>,
  libraryPreferences: () => invoke("libraryPreferences") as ReturnType<NonNullable<MediaBridge["libraryPreferences"]>>,
  saveLibraryPreferences: (options) => invoke("saveLibraryPreferences", options) as ReturnType<NonNullable<MediaBridge["saveLibraryPreferences"]>>,
  savePlayback: (options) => invoke("savePlayback", options) as ReturnType<MediaBridge["savePlayback"]>,
  setMediaWatched: (options) => invoke("setMediaWatched", options) as ReturnType<MediaBridge["setMediaWatched"]>,
  verifyAndScan: (id) => invoke("verifyAndScan", { id }) as ReturnType<MediaBridge["verifyAndScan"]>,
  openTorrentDirectory: (id) => invoke("openTorrentDirectory", { id }) as ReturnType<MediaBridge["openTorrentDirectory"]>,
  chooseDownloadDirectory: async () => { throw new Error("Hors test"); },
  openDownloadDirectory: async () => { throw new Error("Hors test"); },
};
function torrent(id: number, name: string, files: string[]) {
  return { id, hash: id === 77 ? "b".repeat(40) : String(id).padStart(40, "0"), name, addedAt: id * 10000, status: "seeding", percentDone: 1, uploadRatio: 1, files: files.map((name, index) => ({ index, name, length: (id - 70) * 100_000_000, bytesCompleted: (id - 70) * 100_000_000, wanted: true, media: true, scanStatus: "clean" })) } as SecuTorrentTorrent;
}
const torrents = [
  torrent(77, "Voyage.et.Lune.S01.1080p", ["Voyage.et.Lune.S01E01.Le.depart.mp4", "Voyage.et.Lune.S01E02.Escale.mp4", "Voyage.et.Lune.S01E10.Retour.mp4"]),
  torrent(78, "Voyage.and.Lune.S02.1080p", ["Voyage.and.Lune.S02E01.Aurore.mp4", "Voyage.and.Lune.S02E03.Eté.spatial.mp4"]),
  torrent(79, "Collection.Cinema", ["Dune.1984.1080p.mp4", "Dune.2021.1080p.mp4", "Odyssee.2025.1080p.mp4"]),
  torrent(80, "Orbite.Album", ["01.Aurore.flac", "02.Constellation.flac"]),
  torrent(81, "Chroniques.S03", ["Chroniques.S03E01.Le.signal.mp4"]),
  torrent(82, "Voyage.&.Lune.S01.720p", ["Voyage.&.Lune.S01E01.Le.depart.mp4"]),
];
torrents[1].files[1].scanStatus = "not-scanned";
const root = createRoot(document.getElementById("root")!);
let mount = 0;
const render = (data = torrents, remount = false) => { if (remount) mount++; root.render(<MediaLibraryView key={mount} torrents={data} bridge={bridge} />); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(predicate: () => boolean | Promise<boolean>, message: string, timeout = 8000) {
  const start = Date.now();
  while (!await predicate()) { if (Date.now() - start > timeout) throw new Error(message); await sleep(35); }
}
function click(selector: string) { const element = document.querySelector<HTMLButtonElement>(selector); assert(element && !element.disabled, `Bouton indisponible : ${selector}`); element.click(); }
function select(label: string, value: string) { const element = document.querySelector<HTMLSelectElement>(`select[aria-label='${label}']`); assert(element, `Sélecteur absent : ${label}`); element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); }
function search(value: string) { const element = document.querySelector<HTMLInputElement>("input[type=search]")!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }
const cards = () => document.querySelectorAll(".sly-catalog-card").length;
const rows = () => document.querySelectorAll(".sly-media-row").length;
const voyage = "[data-group-key='series:voyage et lune']";
const voyageCard = ".sly-catalog-card:has([data-group-key='series:voyage et lune'])";
const settle = () => sleep(120);
async function remount() {
  const old = document.querySelector("[data-testid='media-library']");
  render(torrents, true);
  await until(() => document.querySelector("[data-testid='media-library']") !== old && Boolean(document.querySelector("[aria-label='Vue Liste']:not(:disabled)")), "Préférences non rechargées");
}
async function run() {
  render();
  await until(() => cards() === 6 && Boolean(document.querySelector("[aria-label='Vue Liste']:not(:disabled)")), "Classement initial incorrect");
  assert(document.querySelector(voyage)?.textContent?.includes("6 fichiers · 2 saisons"), "Saisons non réunies");
  await until(() => Boolean(document.querySelector(".sly-media-thumbnail.is-ready")), "Aperçu vidéo absent");
  assert(getComputedStyle(document.querySelector(".sly-media-thumbnail.is-ready canvas")!).opacity === "1", "Frame vidéo masquée");
  window.scrollTo(0, 0);
  await settle();
  const frameRect = document.querySelector(".sly-media-thumbnail.is-ready canvas")!.getBoundingClientRect();
  await invoke("capture", { name: "catalog-titles", frameRect: { x: Math.ceil(frameRect.x), y: Math.ceil(frameRect.y), width: Math.floor(frameRect.width) - 1, height: Math.floor(frameRect.height) - 1 } });
  click(voyage);
  await until(() => rows() === 6, "Détail inaccessible en un clic");
  assert(document.activeElement === document.querySelector(".sly-catalog-detail h2"), "Focus non transféré au titre");
  assert(document.querySelectorAll(".sly-catalog-seasons button").length === 3, "Saisons manquantes");
  assert(document.querySelectorAll(".sly-media-row-main:disabled").length === 1, "Fichier non validé accessible");
  await invoke("capture", { name: "catalog-series" });
  click(".sly-catalog-seasons button:last-child");
  await until(() => rows() === 2, "Filtre saison incorrect");
  click(".sly-catalog-detail > button");
  await until(() => cards() === 6, "Retour aux titres impossible");
  await until(() => document.activeElement === document.querySelector(voyage), "Focus perdu au retour");
  click(`${voyageCard} .sly-catalog-star`);
  click(".sly-catalog-favorites");
  await until(() => cards() === 1, "Favoris non filtrés");
  await remount();
  await until(async () => Boolean(document.querySelector(`${voyageCard} .sly-catalog-star[aria-pressed=true]`)) && (await bridge.libraryPreferences!()).favorites.length === 1, "Favori perdu au remontage");
  click("[aria-label='Vue Liste']");
  await until(() => rows() === 12, "Vue liste incomplète");
  select("Regrouper la médiathèque", "none");
  select("Trier la médiathèque", "size");
  await until(async () => (await bridge.libraryPreferences!()).sort === "size", "Tri non sauvegardé");
  assert(document.querySelector(".sly-media-row")?.textContent?.includes("1,1 Go"), "Tri par taille incorrect");
  await remount();
  await until(() => rows() === 12 && document.querySelector<HTMLSelectElement>("select[aria-label='Regrouper la médiathèque']")?.value === "none", "Vue liste non conservée");
  search("ete s2e3");
  await until(() => rows() === 1, "Recherche combinée incorrecte");
  assert(Boolean(document.querySelector(".sly-media-row-main:disabled")), "Recherche contourne la validation");
  click(".sly-catalog-refine-toggle");
  await settle();
  select("Filtrer par disponibilité", "ready");
  await until(() => rows() === 0, "Filtres non combinés");
  click(".sly-catalog-reset");
  await until(() => rows() === 12, "Réinitialisation incomplète");
  select("Filtrer par torrent", "78");
  await until(() => rows() === 2, "Filtre torrent incorrect");
  select("Filtrer par saison", "2");
  await settle();
  assert(rows() === 2, "Filtre saison incompatible");
  click(".sly-catalog-reset");
  select("Regrouper la médiathèque", "torrent");
  await until(() => document.querySelectorAll(".sly-catalog-list-group").length === 6, "Regroupement torrent incorrect");
  click(".sly-media-manage summary");
  await settle();
  click(".sly-media-collection-tools button");
  await until(async () => (await invoke("metrics") as { calls: { action?: string }[] }).calls.some((c) => c.action === "verifyAndScan"), "Vérification inaccessible");
  await until(() => Boolean(document.querySelector(".sly-catalog-folder:not(:disabled)")), "Vérification non terminée");
  click(".sly-catalog-folder");
  await until(async () => (await invoke("metrics") as { calls: { action?: string }[] }).calls.some((c) => c.action === "openTorrentDirectory"), "Dossier inaccessible");
  select("Regrouper la médiathèque", "title");
  click("[aria-label='Vue Titres']");
  await until(() => cards() === 6, "Retour grille impossible");
  click(".sly-catalog-favorites");
  await until(() => cards() === 1, "Favori absent");
  click(`${voyageCard} .sly-catalog-star`);
  await until(() => cards() === 0, "Retrait favori non répercuté");
  click(".sly-catalog-reset");
  await until(() => cards() === 6, "Favoris non réinitialisés");
  click(`${voyageCard} footer button`);
  await until(() => (document.querySelector<HTMLVideoElement>("dialog video")?.currentTime || 0) > .1, "Lecture directe bloquée");
  click("[aria-label='Fermer le lecteur']");
  await until(() => !document.querySelector("dialog"), "Lecteur non fermé");
  click(voyage);
  await until(() => rows() === 6, "Détail absent avant suppression");
  render(torrents.filter((t) => ![77, 78, 82].includes(t.id)));
  await until(() => Boolean(document.querySelector(".sly-media-empty")), "Titre supprimé non géré");
  click(".sly-media-empty button");
  render(torrents);
  await until(() => cards() === 6, "Restauration du catalogue impossible");
  await invoke("resize", { small: true });
  await until(() => window.innerWidth === 520, "Redimensionnement impossible");
  window.scrollTo(0, 0);
  await settle();
  assert(document.documentElement.scrollWidth <= window.innerWidth, "Débordement horizontal en petite fenêtre");
  await invoke("capture", { name: "catalog-small" });
  const many = [...torrents, ...Array.from({ length: 40 }, (_, i) => torrent(100 + i, `Film ${i}`, [`Film.${i}.2026.mp4`]))];
  render(many);
  await until(() => cards() === 36, "Pagination des titres absente");
  click(".sly-media-load-more");
  await until(() => cards() === 46, "Suite des titres inaccessible");
  click("[aria-label='Vue Liste']");
  await until(() => rows() === 36, "Pagination liste incorrecte");
  click(".sly-media-load-more");
  await until(() => rows() === 52, "Suite des fichiers inaccessible");
  assert(document.documentElement.scrollWidth <= window.innerWidth, "Débordement horizontal de la liste");
  root.unmount();
  await invoke("finish", { ok: true, message: "Titres réunis, saisons, filtres combinés, favoris et tris persistants, lecture directe, vérification, dossiers, focus, suppression, pagination et petite fenêtre." });
}
void run().catch(async (error: unknown) => {
  const context = document.querySelector(".sly-catalog-results")?.textContent || "Catalogue absent";
  root.unmount();
  await invoke("finish", { ok: false, message: `${error instanceof Error ? error.message : String(error)} · ${context}` });
});
