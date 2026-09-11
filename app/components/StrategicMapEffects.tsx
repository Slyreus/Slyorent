import { useEffect, useLayoutEffect, useRef } from "react";
import { MAP_HEIGHT, MAP_WIDTH, type MapPoint, type MapViewport } from "./strategic-peer-map-model.mjs";
import { fitMap, pointOnCurve, sampleRoute, type MapRoute } from "./strategic-map-scene.mjs";

type EffectsProps = {
  viewport: MapViewport;
  local: MapPoint | null;
  routes: readonly MapRoute[];
  paused: boolean;
  reducedMotion: boolean;
  selectedCity: string | null;
};

const COLORS = { upload: "39, 172, 255", download: "255, 67, 101" };

function glowSprite(rgb: string) {
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = 64;
  const ctx = sprite.getContext("2d")!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, `rgba(${rgb}, .85)`);
  gradient.addColorStop(.18, `rgba(${rgb}, .4)`);
  gradient.addColorStop(.55, `rgba(${rgb}, .09)`);
  gradient.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return sprite;
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
}

function drawRadar(ctx: CanvasRenderingContext2D, local: MapPoint, seconds: number, scale: number, motion: boolean) {
  const unit = 1 / scale;
  ctx.save(); ctx.translate(local.x, local.y);
  ctx.lineWidth = unit;
  for (const radius of [35, 72, 114]) {
    circle(ctx, 0, 0, radius * unit);
    ctx.strokeStyle = `rgba(74, 205, 255, ${radius === 114 ? .1 : .16})`; ctx.stroke();
  }
  for (let tick = 0; tick < 60; tick += 1) {
    const angle = tick * Math.PI / 30;
    const outer = 114 * unit;
    const inner = (tick % 5 === 0 ? 109 : 112) * unit;
    ctx.beginPath(); ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    ctx.strokeStyle = "rgba(80, 200, 241, .27)"; ctx.stroke();
  }
  if (motion) {
    const angle = seconds * .38;
    for (let step = 0; step < 8; step += 1) {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 113 * unit, angle - (step + 1) * .055, angle - step * .055); ctx.closePath();
      ctx.fillStyle = `rgba(50, 193, 238, ${(8 - step) * .006})`; ctx.fill();
    }
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(angle) * 113 * unit, Math.sin(angle) * 113 * unit);
    ctx.strokeStyle = "rgba(97, 226, 255, .35)"; ctx.stroke();
    const pulse = (seconds % 3.5) / 3.5;
    circle(ctx, 0, 0, (12 + pulse * 52) * unit);
    ctx.strokeStyle = `rgba(255, 146, 60, ${(1 - pulse) * .32})`; ctx.stroke();
  }
  ctx.rotate(-seconds * .22);
  ctx.strokeStyle = "rgba(255, 152, 74, .6)";
  ctx.lineWidth = 1.5 * unit;
  for (let part = 0; part < 3; part += 1) {
    ctx.beginPath(); ctx.arc(0, 0, 19 * unit, part * Math.PI * 2 / 3, part * Math.PI * 2 / 3 + .85); ctx.stroke();
  }
  ctx.restore();
}

function drawRoute(ctx: CanvasRenderingContext2D, route: MapRoute, seconds: number, unit: number, sprite: HTMLCanvasElement, selected: string | null, motion: boolean) {
  const rgb = COLORS[route.kind];
  const emphasis = selected && selected !== route.cityKey ? .32 : 1;
  const power = .34 + route.strength * .66;
  ctx.globalAlpha = emphasis;
  if (!motion) {
    ctx.beginPath(); ctx.moveTo(route.curve.from.x, route.curve.from.y);
    ctx.quadraticCurveTo(route.curve.control.x, route.curve.control.y, route.curve.to.x, route.curve.to.y);
    ctx.strokeStyle = `rgba(${rgb}, .6)`; ctx.lineWidth = (1 + route.strength * 2) * unit; ctx.stroke();
    return;
  }
  for (const sample of sampleRoute(route, seconds)) {
    if (sample.type === "flight") {
      const head = pointOnCurve(route.curve, sample.progress);
      const tailProgress = Math.max(0, sample.progress - .19);
      const tail = pointOnCurve(route.curve, tailProgress);
      const gradient = ctx.createLinearGradient(tail.x, tail.y, head.x + .001, head.y);
      gradient.addColorStop(0, `rgba(${rgb}, 0)`);
      gradient.addColorStop(.65, `rgba(${rgb}, ${power * .65})`);
      gradient.addColorStop(1, `rgba(${rgb}, ${power})`);
      ctx.beginPath(); ctx.moveTo(tail.x, tail.y);
      for (let segment = 1; segment <= 12; segment += 1) {
        const point = pointOnCurve(route.curve, tailProgress + (sample.progress - tailProgress) * segment / 12);
        ctx.lineTo(point.x, point.y);
      }
      ctx.strokeStyle = gradient; ctx.lineCap = "round";
      ctx.lineWidth = (5 + route.strength * 5) * unit; ctx.globalAlpha = emphasis * .16; ctx.stroke();
      ctx.lineWidth = (1.25 + route.strength * 2) * unit; ctx.globalAlpha = emphasis; ctx.stroke();
      const size = (19 + route.strength * 17) * unit;
      ctx.drawImage(sprite, head.x - size / 2, head.y - size / 2, size, size);
      const previous = pointOnCurve(route.curve, Math.max(0, sample.progress - .012));
      ctx.save(); ctx.translate(head.x, head.y); ctx.rotate(Math.atan2(head.y - previous.y, head.x - previous.x));
      ctx.beginPath(); ctx.moveTo(4.5 * unit, 0); ctx.lineTo(-3.2 * unit, -1.3 * unit); ctx.lineTo(-1.4 * unit, 0); ctx.lineTo(-3.2 * unit, 1.3 * unit); ctx.closePath();
      ctx.fillStyle = `rgba(235, 251, 255, ${.6 + route.strength * .4})`; ctx.fill(); ctx.restore();
    } else {
      const t = sample.progress;
      const target = route.curve.to;
      const fade = (1 - t) ** 2 * power;
      const radius = (3 + t * (16 + route.strength * 13)) * unit;
      circle(ctx, target.x, target.y, radius);
      ctx.lineWidth = (1.5 - t * .8) * unit; ctx.strokeStyle = `rgba(${rgb}, ${fade})`; ctx.stroke();
      circle(ctx, target.x, target.y, radius * .56);
      ctx.strokeStyle = `rgba(${rgb}, ${fade * .45})`; ctx.stroke();
      const size = (28 + route.strength * 22) * (1 - t * .4) * unit;
      ctx.globalAlpha = emphasis * fade;
      ctx.drawImage(sprite, target.x - size / 2, target.y - size / 2, size, size);
      ctx.strokeStyle = `rgba(${rgb}, .7)`;
      for (let ray = 0; ray < 4; ray += 1) {
        const angle = route.seed * Math.PI * 2 + ray * Math.PI / 2;
        const distance = radius * 1.25;
        ctx.beginPath(); ctx.moveTo(target.x + Math.cos(angle) * distance, target.y + Math.sin(angle) * distance);
        ctx.lineTo(target.x + Math.cos(angle) * (distance + 3 * unit), target.y + Math.sin(angle) * (distance + 3 * unit)); ctx.stroke();
      }
      ctx.globalAlpha = emphasis;
    }
  }
}

export function StrategicMapEffects(props: EffectsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scene = useRef(props);
  const invalidate = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { scene.current = props; invalidate.current?.(); }, [props]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    const sprites = { upload: glowSprite(COLORS.upload), download: glowSprite(COLORS.download) };
    let width = 1000, height = 520, dpr = 1;
    let visible = true, frame = 0, lastTime = 0, seconds = 0, disposed = false;
    const phases = new Map<string, number>();

    const draw = (time: number) => {
      frame = 0;
      if (disposed) return;
      const current = scene.current;
      const running = visible && !document.hidden && !current.paused && !current.reducedMotion;
      canvas.dataset.animating = String(running);
      const elapsed = running && lastTime ? Math.min(.06, Math.max(0, (time - lastTime) / 1000)) : 0;
      seconds += elapsed;
      lastTime = running ? time : 0;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const fit = fitMap(width, height);
      ctx.translate(fit.x, fit.y); ctx.scale(fit.scale, fit.scale);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, MAP_WIDTH, MAP_HEIGHT); ctx.clip();
      ctx.translate(current.viewport.x, current.viewport.y); ctx.scale(current.viewport.k, current.viewport.k);
      ctx.globalCompositeOperation = "lighter";
      const scale = fit.scale * current.viewport.k;
      if (current.local) drawRadar(ctx, current.local, current.reducedMotion ? 0 : seconds, scale, !current.reducedMotion);
      const keys = new Set(current.routes.map((route) => route.key));
      for (const key of phases.keys()) if (!keys.has(key)) phases.delete(key);
      for (const route of current.routes) {
        const cycle = route.duration + .85;
        const phase = ((phases.get(route.key) || 0) + elapsed / cycle) % 1;
        phases.set(route.key, phase);
        drawRoute(ctx, route, phase * cycle, 1 / scale, sprites[route.kind], current.selectedCity, !current.reducedMotion);
      }
      ctx.restore(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
      if (running) frame = window.requestAnimationFrame(draw);
    };
    const wake = () => {
      if (!disposed && !frame) frame = window.requestAnimationFrame(draw);
    };
    invalidate.current = wake;
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, bounds.width); height = Math.max(1, bounds.height);
      // Limite le coût GPU sur les écrans haute densité, y compris en plein écran.
      dpr = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(4_000_000 / (width * height)));
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      wake();
    };
    const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; lastTime = 0; wake(); });
    intersection.observe(canvas);
    const onVisibility = () => { lastTime = 0; wake(); };
    document.addEventListener("visibilitychange", onVisibility);
    resize();
    return () => {
      disposed = true; invalidate.current = null;
      window.cancelAnimationFrame(frame); resizeObserver.disconnect(); intersection.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className="sly-map-effects" aria-hidden="true" data-routes={props.routes.length} />;
}
