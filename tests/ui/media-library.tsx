import { createRoot } from "react-dom/client";
import "../../app/globals.css";
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
  castDiscover: () => invoke("castDiscover") as ReturnType<NonNullable<MediaBridge["castDiscover"]>>,
  castStatus: () => invoke("castStatus") as ReturnType<NonNullable<MediaBridge["castStatus"]>>,
  castStart: (options) => invoke("castStart", options) as ReturnType<NonNullable<MediaBridge["castStart"]>>,
  castControl: (options) => invoke("castControl", options) as ReturnType<NonNullable<MediaBridge["castControl"]>>,
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
  await invoke("resize");
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
  click(".sly-media-surface-toggle");
  await until(() => Boolean(currentVideo()?.paused), "Le clic sur l’image ne met pas la vidéo en pause");
  click(".sly-media-surface-toggle");
  await until(() => currentVideo()?.paused === false, "Le clic sur l’image ne relance pas la vidéo");
  await until(() => subtitleText()?.includes("français") === true, "Les sous-titres français ne s'affichent pas automatiquement");
  await until(() => document.querySelector(".sly-media-caption-line")?.textContent?.includes("français") === true, "Sous-titres absents de l'affichage arrondi");
  assert(currentVideo()?.textTracks[0]?.mode === "hidden", "Le rendu natif ne doit pas doubler les sous-titres");
  assert(Boolean(document.querySelector("footer .sly-media-track-controls")), "Les réglages doivent partager la barre des épisodes");
  video.pause();
  const caption = document.querySelector<HTMLElement>(".sly-media-caption-line")!;
  const stage = document.querySelector<HTMLElement>(".sly-media-stage.video")!;
  const captionStyle = getComputedStyle(caption);
  const fontSize = Number.parseFloat(captionStyle.fontSize);
  const captionFitsStage = () => Math.abs(Number.parseFloat(getComputedStyle(caption).fontSize) - Math.min(64, Math.max(18, 10 + stage.clientWidth * .016))) < .25;
  assert(captionFitsStage() && captionStyle.whiteSpace === "normal", `Les sous-titres doivent suivre la taille du lecteur : ${stage.clientWidth}px, police ${fontSize}px, espaces ${captionStyle.whiteSpace}`);
  assert(caption.offsetWidth > stage.clientWidth * .85 && caption.offsetWidth < stage.clientWidth, "Les sous-titres restent trop étroits ou débordent");
  assert(caption.clientHeight - Number.parseFloat(captionStyle.paddingTop) - Number.parseFloat(captionStyle.paddingBottom) < Number.parseFloat(captionStyle.lineHeight) * 2.5, "Les retours à la ligne du fichier créent encore un bloc trop dense");
  const castButton = document.querySelector<HTMLElement>("[data-player-cast]")!;
  const castStyle = getComputedStyle(castButton);
  assert(castStyle.backgroundColor === "rgb(16, 54, 74)" && Number.parseFloat(castStyle.borderRadius) >= 8 && ["flex", "inline-flex"].includes(castStyle.display), "Le bouton Caster ne reprend pas le style du lecteur");
  await invoke("capture", { name: "player-captions" });
  const player = document.querySelector<HTMLElement>(".sly-media-player")!;
  player.classList.add("is-fallback-fullscreen");
  player.style.width = "1920px"; player.style.height = "1080px";
  await invoke("resize", { wide: true });
  await until(() => captionFitsStage() && Number.parseFloat(getComputedStyle(caption).fontSize) > fontSize * 1.25, "La taille des sous-titres ne suit pas le plein écran");
  await invoke("capture", { name: "player-captions-wide" });
  player.classList.remove("is-fallback-fullscreen");
  player.style.removeProperty("width"); player.style.removeProperty("height");
  await invoke("resize", { small: true });
  await until(() => stage.clientWidth < 530 && captionFitsStage() && Number.parseFloat(getComputedStyle(caption).fontSize) < fontSize, "Les sous-titres ne s'adaptent pas au petit lecteur");
  assert(caption.offsetWidth <= stage.clientWidth && caption.scrollWidth <= caption.clientWidth, "Les sous-titres débordent du petit lecteur");
  await invoke("capture", { name: "player-captions-small" });
  await invoke("resize");
  await until(() => captionFitsStage() && Math.abs(Number.parseFloat(getComputedStyle(caption).fontSize) - fontSize) < .25, "La taille du lecteur n'est pas rétablie");
  await video.play();
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
  await until(() => !video.seeking && Math.abs(video.currentTime - savedTime) < .5, `Position perdue après expiration : ${video.currentTime} au lieu de ${savedTime}`);
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
  [...document.querySelectorAll<HTMLButtonElement>(".sly-media-filter-tabs button")].find((item) => item.textContent === "Tout")!.click();
  await until(() => Boolean(document.querySelector(firstButton)), "Liste absente"); click(firstButton);
  await until(() => Boolean(document.querySelector("[data-player-cast]:not(:disabled)")), "Bouton Caster indisponible");
  const nativeFullscreen = await invoke("fullscreen");
  if (!nativeFullscreen) {
    document.querySelector<HTMLElement>(".sly-media-player")!.requestFullscreen = async () => { throw new Error("Plein écran indisponible dans le test"); };
    click("[aria-label='Activer le plein écran']");
    await until(() => Boolean(document.querySelector(".is-fallback-fullscreen")), "Plein écran de secours absent");
  }
  click("[data-player-cast]");
  await until(() => Boolean(document.querySelector("#sly-cast-device option[value='tv-test']")), "Découverte des appareils absente");
  assert(!document.fullscreenElement && !document.querySelector(".is-fallback-fullscreen"), "La sélection de cast doit quitter le plein écran du lecteur");
  const castingDialog = document.querySelector<HTMLDialogElement>(".sly-cast-dialog")!, castingRect = castingDialog.getBoundingClientRect();
  assert(castingDialog.matches(":modal") && document.elementFromPoint(castingRect.x + castingRect.width / 2, castingRect.y + castingRect.height / 2)?.closest("dialog") === castingDialog, "La sélection de cast reste masquée par le lecteur");
  assert(document.querySelector<HTMLInputElement>(".sly-cast-check input")?.checked, "Enchaînement automatique désactivé par défaut");
  click(".sly-cast-dialog footer .sly-media-primary");
  await until(() => Boolean(document.querySelector(".sly-cast-launching")), "Aucun retour visuel pendant la connexion au cast");
  await until(() => Boolean(document.querySelector(".sly-cast-panel")) && !currentVideo(), "La lecture locale doit céder la place au cast");
  assert(document.querySelector(".sly-cast-panel")?.textContent?.includes("TV de test"), "Appareil sélectionné absent");
  await until(() => document.activeElement?.classList.contains("sly-cast-panel") === true, "Le suivi du cast n’est pas mis en évidence");
  assert(document.querySelector<HTMLProgressElement>(".sly-cast-preparation progress")?.value === 42, "Progression de préparation du cast absente");
  assert(document.querySelectorAll(".sly-cast-queue li").length === 4, "File d’épisodes du cast absente");
  await invoke("capture", { name: "player-cast-preparing" });
  await until(() => Boolean(document.querySelector("[aria-label='Mettre le cast en pause']:not(:disabled)")), "Lecture distante non prête");
  const castPanel = document.querySelector<HTMLElement>(".sly-cast-panel")!;
  assert(getComputedStyle(castPanel).color === "rgb(234, 245, 252)", "Le texte du cast reste sombre sur fond sombre");
  await invoke("capture", { name: "player-cast-playing" });
  click("[aria-label='Mettre le cast en pause']");
  await until(() => Boolean(document.querySelector("[aria-label='Reprendre le cast']:not(:disabled)")), "Pause distante non suivie");
  click("[aria-label='Reprendre le cast']");
  await until(() => Boolean(document.querySelector("[aria-label='Mettre le cast en pause']:not(:disabled)")), "Reprise distante non suivie");
  const seek = document.querySelector<HTMLInputElement>("[aria-label='Position sur l’appareil']")!;
  seek.value = "500"; seek.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }));
  await until(() => document.querySelector(".sly-cast-timeline small")?.textContent?.includes("0:30") === true, "Position distante non actualisée");
  const volume = document.querySelector<HTMLInputElement>("[aria-label='Volume sur l’appareil']")!;
  volume.value = "25"; volume.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowLeft", bubbles: true }));
  await until(() => document.querySelector(".sly-cast-volume small")?.textContent === "25 %", "Volume distant non actualisé");
  click(".sly-cast-queue li:nth-child(3) button");
  await until(() => document.querySelector(".sly-cast-queue li:nth-child(3)")?.getAttribute("aria-current") === "true", "Sélection d’épisode distante non suivie");
  await invoke("resize", { small: true });
  await sleep(120);
  assert(castPanel.scrollWidth <= castPanel.clientWidth, "Le suivi du cast déborde de la petite fenêtre");
  const castQueue = document.querySelector<HTMLOListElement>(".sly-cast-queue ol")!;
  assert(castQueue.scrollWidth <= castQueue.clientWidth, "La file d’épisodes crée un défilement horizontal");
  await until(() => { const current = castQueue.querySelector("[aria-current='true']")!.getBoundingClientRect(), bounds = castQueue.getBoundingClientRect(); return current.top >= bounds.top - 1 && current.bottom <= bounds.bottom + 1; }, "L’épisode en cours est masqué dans la file après redimensionnement");
  await invoke("capture", { name: "player-cast-small" });
  await invoke("resize");
  await invoke("castFailure");
  await until(() => castPanel.textContent?.includes("Appareil de test déconnecté.") === true, "L’erreur de connexion masque le suivi du cast");
  await invoke("capture", { name: "player-cast-error" });
  const retry = [...castPanel.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes("Réessayer"))!;
  retry.click();
  await until(() => Boolean(document.querySelector("[aria-label='Mettre le cast en pause']:not(:disabled)")), "Reconnexion au cast impossible");
  const stop = [...document.querySelectorAll<HTMLButtonElement>(".sly-cast-panel button")].find((item) => item.textContent?.includes("Arrêter le cast"))!; stop.click();
  await until(() => !document.querySelector(".sly-cast-panel"), "Cast non arrêté");
  root.unmount();
  await invoke("finish", { ok: true, message: "Lecteur local, suivi, langues et sous-titres. Sélection d’appareil, transfert au cast et arrêt." });
}
void run().catch(async (error: unknown) => {
  const context = document.querySelector("dialog")?.textContent || "Aucun dialogue";
  root.unmount();
  await invoke("finish", { ok: false, message: `${error instanceof Error ? error.message : String(error)} · ${context}` });
});
