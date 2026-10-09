import { createRoot } from "react-dom/client";
import { MediaLibraryView, type MediaBridge } from "../../app/components/MediaLibrary";

declare global { interface Window { mediaTest: { invoke: (method: string, params?: object) => Promise<unknown> } } }
const invoke = window.mediaTest.invoke;
const bridge: MediaBridge = {
  openMedia: (options) => invoke("openMedia", options) as ReturnType<MediaBridge["openMedia"]>,
  openSubtitle: (options) => invoke("openSubtitle", options) as ReturnType<NonNullable<MediaBridge["openSubtitle"]>>,
  renewMedia: (url) => invoke("renewMedia", { url }) as ReturnType<MediaBridge["renewMedia"]>,
  releaseMedia: (url) => invoke("releaseMedia", { url }) as ReturnType<MediaBridge["releaseMedia"]>,
  cancelMediaPreparation: (requestId) => invoke("cancelMediaPreparation", { requestId }) as ReturnType<MediaBridge["cancelMediaPreparation"]>,
  mediaPreparation: (requestId) => invoke("mediaPreparation", { requestId }) as ReturnType<MediaBridge["mediaPreparation"]>,
  watchHistory: () => invoke("watchHistory") as ReturnType<MediaBridge["watchHistory"]>,
  libraryPreferences: () => invoke("libraryPreferences") as ReturnType<NonNullable<MediaBridge["libraryPreferences"]>>,
  saveLibraryPreferences: (options) => invoke("saveLibraryPreferences", options) as ReturnType<NonNullable<MediaBridge["saveLibraryPreferences"]>>,
  savePlayback: (options) => invoke("savePlayback", options) as ReturnType<MediaBridge["savePlayback"]>,
  setMediaWatched: (options) => invoke("setMediaWatched", options) as ReturnType<MediaBridge["setMediaWatched"]>,
  verifyAndScan: async () => { throw new Error("Hors test"); },
  chooseDownloadDirectory: async () => { throw new Error("Hors test"); },
  openDownloadDirectory: async () => { throw new Error("Hors test"); },
  openTorrentDirectory: async () => { throw new Error("Hors test"); },
};
const torrents = [{ id: 77, hash: "b".repeat(40), name: "Voyage.S01", status: "seeding", percentDone: 1, uploadRatio: 1, files: Array.from({ length: 4 }, (_, index) => ({ index, name: `Voyage.S01E0${index + 1}.Escale.${index + 1}.mp4`, length: 1000, bytesCompleted: 1000, wanted: true, media: true, scanStatus: "clean" })) }] as SecuTorrentTorrent[];
const root = createRoot(document.getElementById("root")!);
const render = (key = 0) => root.render(<MediaLibraryView key={key} torrents={torrents} bridge={bridge} />);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(predicate: () => boolean | Promise<boolean>, message: string, timeout = 12_000) {
  const start = Date.now();
  while (!await predicate()) { if (Date.now() - start > timeout) throw new Error(message); await sleep(35); }
}
function click(selector: string) { const element = document.querySelector<HTMLButtonElement>(selector); assert(element && !element.disabled, `Bouton indisponible : ${selector}`); element.click(); }
const currentVideo = () => document.querySelector<HTMLVideoElement>("dialog video");
const firstButton = ".sly-media-row-main";
const closeButton = "[aria-label='Fermer le lecteur']";
const nextButton = "[aria-label='Épisode suivant']";
const records = () => bridge.watchHistory();
const recordKey = (index: number) => `${"b".repeat(40)}:${index}`;
function chooseTrack(label: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`[aria-label='${label}']`);
  assert(select && !select.disabled, `Sélecteur indisponible : ${label}`);
  select.value = value; select.dispatchEvent(new Event("change", { bubbles: true }));
}
const subtitleText = () => (currentVideo()?.textTracks[0]?.activeCues?.[0] as VTTCue | undefined)?.text;

async function run() {
  render();
  await until(() => Boolean(document.querySelector("[aria-label='Vue Liste']:not(:disabled)")), "Préférences non chargées");
  click("[aria-label='Vue Liste']");
  await until(() => document.querySelectorAll(".sly-media-row-main:not(:disabled)").length === 4, "Les épisodes ne sont pas directement accessibles");
  await until(() => Boolean(document.querySelector(".sly-media-thumbnail.is-ready")), "Vignette vidéo absente");
  assert(document.querySelectorAll("video").length === 0, "Un lecteur de vignette reste actif");
  click(firstButton);
  await until(() => (currentVideo()?.currentTime || 0) > .2, "Démarrage vidéo impossible");
  let video = currentVideo()!;
  assert(!video.muted, "Audio coupé par défaut");
  await until(() => subtitleText()?.includes("français") === true, "Les sous-titres français ne s'affichent pas automatiquement");
  await until(() => document.querySelector(".sly-media-caption-line")?.textContent?.includes("français") === true, "Sous-titres absents de l'affichage arrondi");
  assert(currentVideo()?.textTracks[0]?.mode === "hidden", "Le rendu natif ne doit pas doubler les sous-titres");
  assert(Boolean(document.querySelector("footer .sly-media-track-controls")), "Les réglages doivent partager la barre des épisodes");
  video.textTracks[0].mode = "disabled";
  await until(() => document.querySelector<HTMLSelectElement>("[aria-label='Sous-titres']")?.value === "", "Désactivation native des sous-titres non suivie");
  chooseTrack("Sous-titres", "4");
  await until(() => subtitleText()?.includes("English") === true, "Changement de sous-titres impossible");
  chooseTrack("Sous-titres", "3");
  await until(() => subtitleText()?.includes("français") === true, "Retour aux sous-titres français impossible");
  video.pause(); video.currentTime = 18;
  await until(async () => ((await records())[recordKey(0)]?.position || 0) >= 18, "Position de pause non sauvegardée");
  video.volume = .36; video.playbackRate = 1.25;
  const audioUrl = video.src;
  chooseTrack("Piste audio", "2");
  await until(() => Boolean(currentVideo() && currentVideo()!.src !== audioUrl && currentVideo()!.readyState >= 2), "Changement audio bloqué");
  video = currentVideo()!;
  assert(video.paused && Math.abs(video.currentTime - 18) < .5, "Position ou pause perdue lors du changement audio");
  assert(Math.abs(video.volume - .36) < .01 && video.playbackRate === 1.25, "Volume ou vitesse perdus lors du changement audio");
  assert(document.querySelector<HTMLSelectElement>("[aria-label='Sous-titres']")?.value === "3", "Choix explicite des sous-titres perdu après changement audio");
  click(closeButton);
  await until(() => !document.querySelector("dialog"), "Lecteur non fermé");
  const oldLibrary = document.querySelector("[data-testid='media-library']");
  render(1);
  await until(() => document.querySelector("[data-testid='media-library']") !== oldLibrary, "Médiathèque non remontée");
  await until(() => Boolean(document.querySelector(".sly-media-resume-section")), "Suivi perdu au remontage");
  click(firstButton);
  await until(() => Boolean(document.querySelector(".sly-media-resume-prompt")), "Proposition de reprise absente");
  click(".sly-media-resume-prompt .sly-media-primary");
  await until(() => (currentVideo()?.currentTime || 0) >= 18 && !currentVideo()?.paused, "Reprise au mauvais endroit");
  video = currentVideo()!;
  video.pause();
  const savedTime = video.currentTime;
  const oldUrl = video.src;
  video.volume = .36;
  await invoke("expire");
  window.dispatchEvent(new Event("focus"));
  await until(() => Boolean(currentVideo() && currentVideo()!.src !== oldUrl && currentVideo()!.readyState >= 2), "Accès expiré non remplacé");
  video = currentVideo()!;
  assert(Math.abs(video.currentTime - savedTime) < .5, "Position perdue après expiration");
  assert(video.paused, "Lecture relancée sans demande après la pause");
  assert(Math.abs(video.volume - .36) < .01, "Volume perdu après récupération");
  await video.play();
  await until(() => Boolean(document.querySelector(".sly-media-next-ready")), "Épisode suivant non préparé", 18_000);
  const start = Date.now();
  const previousUrl = currentVideo()!.src;
  click(nextButton);
  await until(() => Boolean(currentVideo() && currentVideo()!.src !== previousUrl && currentVideo()!.currentTime > .1), "Épisode suivant bloqué");
  const metrics = await invoke("metrics") as { calls: { purpose: string; fileIndex: number }[] };
  assert(metrics.calls.filter((call) => call.purpose === "playback" && call.fileIndex === 1).length === 1, "Préparation du suivant dupliquée");
  assert(Date.now() - start < 2500, "Passage au suivant trop lent malgré le préchargement");
  video = currentVideo()!;
  video.currentTime = video.duration - .25;
  await video.play();
  await until(async () => Boolean((await records())[recordKey(1)]?.completed), "Fin de lecture non enregistrée");
  await invoke("delay");
  click(nextButton);
  await until(async () => (await invoke("metrics") as { calls: { fileIndex: number; purpose: string }[] }).calls.some((call) => call.fileIndex === 2 && call.purpose === "playback"), "Préparation différée non démarrée");
  assert(Boolean(document.querySelector("dialog")), "Dialogue absent pendant la préparation");
  await until(() => Boolean(document.querySelector("dialog")?.textContent?.includes("42 %")), "Progression de la conversion absente");
  click(closeButton);
  await sleep(2500);
  assert(!document.querySelector("dialog"), "Le chargement terminé rouvre le lecteur fermé");
  await until(async () => (await invoke("metrics") as { outstanding: number }).outstanding === 0, "Accès média non libérés");
  const completed = [...document.querySelectorAll<HTMLButtonElement>(".sly-media-filter-tabs button")].find((item) => item.textContent === "Terminés")!;
  completed.click();
  await until(() => document.querySelectorAll(".sly-media-row").length === 1, "Filtre des médias terminés incorrect");
  click(".sly-media-mark");
  await until(() => document.querySelectorAll(".sly-media-row").length === 0, "Remise à zéro du visionnage impossible");
  root.unmount();
  await invoke("finish", { ok: true, message: "Sous-titres affichés, choix de langue, changement audio avec conservation de la pause, position, volume et vitesse. Suivi, reprise et préparation suivante." });
}
void run().catch(async (error: unknown) => {
  const context = document.querySelector("dialog")?.textContent || "Aucun dialogue";
  root.unmount();
  await invoke("finish", { ok: false, message: `${error instanceof Error ? error.message : String(error)} · ${context}` });
});
