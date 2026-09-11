"use client";

import { Film, LoaderCircle, Music2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MediaEpisode } from "../../lib/media-library";
import { isLocalMediaUrl } from "../../lib/media-playback";
import type { MediaBridge } from "./MediaLibrary";

const frames = new Map<string, HTMLCanvasElement>();
let active = 0;
const queue: Array<() => void> = [];
function pump() { while (active < 2 && queue.length) queue.shift()?.(); }
function schedule<T>(task: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    queue.push(() => { active += 1; task().then(resolve, reject).finally(() => { active -= 1; pump(); }); });
    pump();
  });
}

async function capture(episode: Pick<MediaEpisode, "watchKey" | "length" | "torrentId" | "fileIndex">, bridge: MediaBridge, signal: AbortSignal) {
  signal.throwIfAborted();
  const cacheKey = `${episode.watchKey}:${episode.length}`;
  const cached = frames.get(cacheKey);
  if (cached) return cached;
  const access = await bridge.openMedia({ id: episode.torrentId, fileIndex: episode.fileIndex, purpose: "thumbnail" });
  try {
    signal.throwIfAborted();
    if (!isLocalMediaUrl(access.url)) throw new Error("Vignette locale refusée.");
    return await new Promise<HTMLCanvasElement>((resolve, reject) => {
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      const finish = (error?: Error, frame?: HTMLCanvasElement) => {
        window.clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
        video.pause();
        video.removeAttribute("src");
        video.load();
        if (frame) resolve(frame); else reject(error || new Error("Vignette indisponible."));
      };
      const abort = () => finish(new DOMException("Vignette annulée.", "AbortError"));
      const timer = window.setTimeout(() => finish(new Error("Vignette trop lente.")), 10_000);
      const draw = () => {
        if (video.seeking || !video.videoWidth || (video.currentTime === 0 && video.duration > 1)) return;
        const canvas = document.createElement("canvas");
        canvas.width = 256; canvas.height = 144;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) { finish(); return; }
        try {
          const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
          context.drawImage(video, (canvas.width - video.videoWidth * scale) / 2, (canvas.height - video.videoHeight * scale) / 2, video.videoWidth * scale, video.videoHeight * scale);
          frames.set(cacheKey, canvas);
          while (frames.size > 96) frames.delete(frames.keys().next().value!);
          finish(undefined, canvas);
        } catch { finish(); }
      };
      video.onloadedmetadata = () => {
        if (Number.isFinite(video.duration) && video.duration > 1) video.currentTime = Math.min(32, video.duration * .1);
      };
      video.onseeked = draw;
      video.onloadeddata = draw;
      video.onerror = () => finish();
      signal.addEventListener("abort", abort, { once: true });
      video.src = access.url;
    });
  } finally { if (isLocalMediaUrl(access.url)) void bridge.releaseMedia(access.url).catch(() => undefined); }
}

export function VideoThumbnail({ episode, getBridge, suspended = false }: { episode: MediaEpisode; getBridge: () => MediaBridge; suspended?: boolean }) {
  const { watchKey, length, torrentId, fileIndex, playable, kind } = episode;
  const rootRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<"fallback" | "loading" | "ready" | "error">("fallback");
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !episode.playable || episode.kind !== "video") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "80px" });
    observer.observe(root);
    return () => observer.disconnect();
  }, [episode.playable, episode.kind]);
  useEffect(() => {
    if (!visible || suspended || !playable || kind !== "video") return;
    const controller = new AbortController();
    void schedule(async () => {
      controller.signal.throwIfAborted();
      setState("loading");
      return capture({ watchKey, length, torrentId, fileIndex }, getBridge(), controller.signal);
    }).then((frame) => {
      if (controller.signal.aborted) return;
      canvasRef.current?.getContext("2d")?.drawImage(frame, 0, 0);
      setState("ready");
    }).catch(() => { if (!controller.signal.aborted) setState("error"); });
    return () => controller.abort();
  }, [fileIndex, kind, length, playable, torrentId, watchKey, getBridge, suspended, visible]);
  return <span ref={rootRef} className={`sly-media-thumbnail is-${state}`} aria-hidden="true">
    <span className="sly-media-thumbnail-fallback">{episode.kind === "audio" ? <Music2 size={25} /> : <Film size={25} />}</span>
    <canvas width={256} height={144} ref={canvasRef} />
    <span className="sly-media-thumbnail-label">{episode.extension.toUpperCase()}</span>
    {state === "loading" && !suspended && <LoaderCircle size={12} className="sly-media-thumbnail-loader sly-media-spin" />}
  </span>;
}
