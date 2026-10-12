const video = document.querySelector("#video"), captions = document.querySelector("#captions");
let token, epoch = "", version = -1, busy = false, reporting = false, ended = false, wantsPlayback = false;
async function api(path, data = {}) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data), cache: "no-store" });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || "Connexion interrompue."); return result;
}
document.querySelector("#pair").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { const result = await api("/api/pair", { code: document.querySelector("#code").value }); token = result.token; document.querySelector("#pair").hidden = true; document.querySelector("#player").hidden = false; await poll(); }
  catch (error) { document.querySelector("#error").textContent = error.message; }
});
document.querySelector("#play").addEventListener("click", () => { void video.play().catch(() => undefined); });
video.addEventListener("ended", () => { ended = true; void report(); });
video.addEventListener("error", () => { document.querySelector("#status").textContent = "Format refusé par ce navigateur."; void report(true); });
async function report(failed = false) {
  if (!token || !epoch || reporting || video.readyState < 1 && !failed) return;
  reporting = true;
  try { await api("/api/report", { epoch, version, position: video.currentTime || 0, duration: Number.isFinite(video.duration) ? video.duration : 0, volume: video.volume, playing: !video.paused && !video.ended, ended, failed }); }
  catch { video.pause(); document.querySelector("#status").textContent = "Cast arrêté ou connexion perdue."; }
  finally { reporting = false; }
}
async function poll() {
  if (!token || busy) return; busy = true;
  try {
    const state = await api("/api/state");
    document.querySelector("#status").textContent = state.loading ? "Préparation sur le PC…" : state.error || "Connecté au PC";
    if (state.media && state.epoch !== epoch) {
      epoch = state.epoch; ended = false; wantsPlayback = state.playing; captions.replaceChildren();
      video.pause(); video.replaceChildren(); video.src = state.media.url; document.querySelector("#title").textContent = state.media.title;
      if (state.media.subtitleUrl) {
        const track = document.createElement("track"); track.kind = "subtitles"; track.src = state.media.subtitleUrl; track.default = true;
        track.addEventListener("load", () => { track.track.mode = "hidden"; });
        track.track.addEventListener("cuechange", () => { captions.replaceChildren(...Array.from(track.track.activeCues || []).map((cue) => { const span = document.createElement("span"); span.textContent = cue.getCueAsHTML().textContent; return span; })); });
        video.append(track);
      }
      video.addEventListener("loadedmetadata", () => { video.currentTime = Math.min(state.position || 0, video.duration); if (wantsPlayback) void video.play().catch(() => { document.querySelector("#status").textContent = "Appuyez sur Lire pour démarrer."; }); }, { once: true });
      video.load();
    }
    if (state.version !== version) {
      version = state.version;
      if (video.readyState >= 1 && state.command?.action === "seek") video.currentTime = state.command.value;
      if (state.command?.action === "pause") { wantsPlayback = false; video.pause(); }
      if (state.command?.action === "play") { wantsPlayback = true; void video.play().catch(() => undefined); }
      if (state.command?.action === "volume") video.volume = state.command.value;
    }
    await report();
  } catch { video.pause(); document.querySelector("#status").textContent = "Cast arrêté ou connexion perdue."; }
  finally { busy = false; }
}
setInterval(() => { void poll(); }, 1000);
