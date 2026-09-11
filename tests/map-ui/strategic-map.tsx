import { createRoot } from "react-dom/client";
import { StrategicPeerMap, type StrategicLocalNode, type StrategicPeer, type StrategicPeerSnapshot } from "../../app/components/StrategicPeerMap";

declare global { interface Window { mapTest: { invoke: (method: string, params?: object) => Promise<unknown> } } }
const preview = location.hash === "#preview";
const invoke = window.mapTest.invoke;
const root = createRoot(document.getElementById("root")!);
const positions = [
  ["Montréal", "Canada", "CA", 45.5, -73.6], ["San Francisco", "États-Unis", "US", 37.8, -122.4],
  ["São Paulo", "Brésil", "BR", -23.5, -46.6], ["Londres", "Royaume-Uni", "GB", 51.5, -.1],
  ["Berlin", "Allemagne", "DE", 52.5, 13.4], ["Tokyo", "Japon", "JP", 35.7, 139.7],
  ["Singapour", "Singapour", "SG", 1.3, 103.8], ["Sydney", "Australie", "AU", -33.9, 151.2],
  ["Le Cap", "Afrique du Sud", "ZA", -33.9, 18.4], ["Mumbai", "Inde", "IN", 19.1, 72.9],
];
const peers: StrategicPeer[] = Array.from({ length: 23 }, (_, index) => {
  const [city, country, countryCode, latitude, longitude] = positions[index % positions.length];
  return { id: `TestPeer_${String(index).padStart(8, "0")}`, city: String(city), country: String(country), countryCode: String(countryCode), latitude: Number(latitude), longitude: Number(longitude), locationStatus: "resolved", rateUpload: index % 3 === 0 ? 0 : 150_000 + index * 114_000, rateDownload: index % 3 === 1 ? 0 : 280_000 + index * 246_000, active: true, torrentName: "Vidéo synthétique" };
});
const base: StrategicLocalNode = { source: "manual", latitude: 46, longitude: 2 };
let key = 0;
const render = (data = peers, local: StrategicLocalNode | null = base, capturedAt = new Date().toISOString()) => {
  const snapshot: StrategicPeerSnapshot = { capturedAt, peers: data, geoProvider: { offline: true, available: true } };
  root.render(<><p className="fixture-note"><strong>APERÇU DE TEST</strong> · Données fictives · Aucun moteur torrent · Aucune position personnelle</p><StrategicPeerMap key={key} snapshot={snapshot} localNode={local} /></>);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function until(predicate: () => boolean, message: string, timeout = 7_000) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error(message); await sleep(30); }
}
function click(label: string) { const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); assert(button && !button.disabled, `Bouton absent : ${label}`); button.click(); }
const canvas = () => document.querySelector<HTMLCanvasElement>(".sly-map-effects")!;
const routes = () => document.querySelectorAll(".sly-map-route").length;
function fingerprint() {
  const image = canvas().getContext("2d")!.getImageData(0, 0, canvas().width, canvas().height).data;
  let sum = 0;
  for (let i = 0; i < image.length; i += 37) sum = (sum * 33 + image[i]) >>> 0;
  return sum;
}

async function run() {
  // Les lectures de pixels de ce test utilisent un canvas CPU dès le départ,
  // sans bascule GPU/CPU qui modifierait l'anticrénelage entre deux captures.
  const originalContext = HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { value: function (this: HTMLCanvasElement, kind: string, options: object = {}) { return originalContext.call(this, kind, kind === "2d" ? { ...options, willReadFrequently: true } : options); } });
  const pendingFrames = new Set<number>();
  const request = window.requestAnimationFrame.bind(window);
  const cancel = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => { const handle = request((time) => { pendingFrames.delete(handle); callback(time); }); pendingFrames.add(handle); return handle; };
  window.cancelAnimationFrame = (handle) => { pendingFrames.delete(handle); cancel(handle); };
  render();
  await until(() => routes() === 20 && canvas().dataset.animating === "true", "Routes actives absentes");
  await sleep(450);
  const initial = fingerprint();
  assert(initial !== 0, "Canvas vide");
  await sleep(250);
  assert(fingerprint() !== initial, "Les effets ne bougent pas");
  assert(document.querySelectorAll(".sly-map-city").length === 10, "Les villes ne sont pas regroupées");
  const viewport = () => document.querySelector("[data-testid='map-viewport']")!.getAttribute("transform");
  const beforeZoom = viewport();
  click("Zoomer sur la carte"); await sleep(500);
  assert(viewport() !== beforeZoom, "Zoom inactif");
  click("Vue mondiale"); await until(() => viewport() === "translate(0 0) scale(1)", "Vue mondiale non stabilisée");
  assert(viewport() === "translate(0 0) scale(1)", "Vue mondiale incorrecte");
  const surface = document.querySelector<HTMLButtonElement>(".sly-map-surface")!;
  const bounds = surface.getBoundingClientRect();
  const wheel = new WheelEvent("wheel", { deltaY: -200, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2, bubbles: true, cancelable: true });
  surface.dispatchEvent(wheel); await sleep(500);
  assert(wheel.defaultPrevented && viewport() !== "translate(0 0) scale(1)", "Molette non capturée ou zoom inactif");
  const city = document.querySelector<SVGGElement>(".sly-map-city")!;
  city.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => Boolean(document.querySelector(".sly-map-city-detail")), "Sélection clavier impossible");
  click("Fermer le détail de la zone");
  const select = document.querySelector<HTMLSelectElement>(".sly-map-intel select")!;
  select.selectedIndex = 2; select.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => Boolean(document.querySelector(".sly-map-city-detail")), "Sélection d’une zone impossible");
  click("Vue mondiale"); await until(() => viewport() === "translate(0 0) scale(1)", "Caméra non stabilisée avant pause");
  click("Figer les animations"); await sleep(500);
  const paused = fingerprint(); await sleep(300);
  assert(fingerprint() === paused && canvas().dataset.animating === "false", "Animations non figées");
  click("Animer la carte"); await sleep(250);
  assert(fingerprint() !== paused, "Animations non relancées");
  render(peers, null); await until(() => routes() === 0, "Des tirs restent sans base");
  render(peers, base, new Date(Date.now() - 20_000).toISOString());
  await until(() => document.querySelector(".sly-map")?.getAttribute("data-fresh") === "false", "Snapshot périmé accepté");
  assert(routes() === 0, "Des tirs continuent avec des données anciennes");
  render(peers.map((peer) => ({ ...peer, rateUpload: 0, rateDownload: 0, active: false })));
  await until(() => document.querySelector(".sly-map-signal")?.textContent?.includes("Aucun transfert") === true, "État calme absent");
  assert(routes() === 0, "Trafic inventé à débit nul");
  render(); await until(() => routes() === 20, "Reconnexion non affichée");
  await invoke("fullscreen"); await until(() => Boolean(document.fullscreenElement), "Plein écran impossible");
  assert(canvas().getBoundingClientRect().height > 500, "Carte non agrandie en plein écran");
  await until(() => Boolean(document.querySelector("button[aria-label='Quitter le plein écran']")), "Commande plein écran non actualisée");
  click("Quitter le plein écran"); await until(() => !document.fullscreenElement, "Sortie du plein écran impossible");
  const originalMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query) => { const result = originalMatchMedia(query); if (query === "(prefers-reduced-motion: reduce)") Object.defineProperty(result, "matches", { value: true }); return result; };
  key += 1; render(); await until(() => Boolean(document.querySelector<HTMLButtonElement>("button[aria-label='Figer les animations']")?.disabled), "Mouvements réduits ignorés");
  click("Vue mondiale"); await until(() => viewport() === "translate(0 0) scale(1)", "Caméra réduite non stabilisée");
  await sleep(900); const still = fingerprint(); const stillViewport = viewport(); const stillSize = `${canvas().width}x${canvas().height}`; await sleep(350);
  const sameFrameA = fingerprint(), sameFrameB = fingerprint();
  assert(sameFrameA === still && canvas().dataset.animating === "false", `Animation active malgré les mouvements réduits (${still}/${sameFrameA}/${sameFrameB}, ${stillViewport}/${viewport()}, ${stillSize}/${canvas().width}x${canvas().height})`);
  window.matchMedia = originalMatchMedia;
  key += 1;
  const many = Array.from({ length: 512 }, (_, index) => ({ ...peers[index % peers.length], id: `StressPeer_${String(index).padStart(8, "0")}`, latitude: -75 + index % 150, longitude: -170 + index % 340 }));
  render(many); await until(() => routes() === 64, "Limite des routes non respectée");
  await sleep(500);
  assert(canvas().dataset.animating === "true", "Animation bloquée avec 512 pairs");
  await invoke("resize"); await sleep(400);
  assert(document.documentElement.scrollWidth <= window.innerWidth, "Débordement sur petit écran");
  const panel = document.querySelector(".sly-map-intel")!.getBoundingClientRect();
  const frame = document.querySelector(".sly-map-frame")!.getBoundingClientRect();
  assert(panel.left >= frame.left && panel.right <= frame.right + 1, "Détail hors cadre");
  root.unmount(); await sleep(150);
  assert(pendingFrames.size === 0, "Boucle d’animation conservée après fermeture");
  await invoke("finish", { ok: true, message: "Tirs animés, regroupement, zoom, molette, sélection clavier, pause, données périmées, plein écran, mouvements réduits, 512 pairs, petit écran et nettoyage." });
}

if (preview) { render(); window.setInterval(() => render(), 1_200); }
else void run().catch(async (error: unknown) => { const state = `routes=${routes()}, animation=${canvas()?.dataset.animating}, visible=${document.visibilityState}, signal=${document.querySelector(".sly-map-signal")?.textContent}`; root.unmount(); await invoke("finish", { ok: false, message: `${error instanceof Error ? error.message : String(error)} · ${state}` }); });
