"use client";

/**
 * The face of Mo: a grid of small squares swept by a violet wave. Plays an
 * intro on arrival (the squares light up in a wave from the left), then
 * breathes in the background; it reacts to the microphone level while the
 * consultant speaks and ripples faster while Mo works.
 */

import { useEffect, useRef } from "react";

export type WaveMood = "intro" | "idle" | "listening" | "thinking" | "speaking";

interface Props { mood: WaveMood; /** 0..1 microphone level (listening) */ level?: number; className?: string }

const CELL = 14;
const SQUARE = 9;
// violet-950 → violet-700 → violet-400 → fuchsia-300
const STOPS: Array<[number, [number, number, number]]> = [
  [0, [24, 12, 48]],
  [0.35, [91, 33, 182]],
  [0.7, [167, 139, 250]],
  [1, [240, 171, 252]],
];

function colorAt(v: number): string {
  const t = Math.min(1, Math.max(0, v));
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, a] = STOPS[i - 1]; const [t1, b] = STOPS[i];
      const k = (t - t0) / (t1 - t0);
      return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)})`;
    }
  }
  return "rgb(240,171,252)";
}

export function WaveCanvas({ mood, level = 0, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const moodRef = useRef(mood);
  const levelRef = useRef(level);
  useEffect(() => { moodRef.current = mood; levelRef.current = level; }, [mood, level]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let w = 0, h = 0, cols = 0, rows = 0;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const start = performance.now();
    // Palette cache: 64 steps are plenty for 10k squares a frame.
    const palette = Array.from({ length: 65 }, (_, i) => colorAt(i / 64));
    let smoothLevel = 0;
    let smoothMood = 0; // 0 idle … 1 thinking (eases the transitions)

    const resize = () => {
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / CELL) + 1; rows = Math.ceil(h / CELL) + 1;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (now: number) => {
      const t = (now - start) / 1000;
      const m = moodRef.current;
      smoothLevel += (levelRef.current - smoothLevel) * 0.15;
      const targetMood = m === "thinking" ? 1 : m === "speaking" ? 0.6 : m === "listening" ? 0.35 : 0;
      smoothMood += (targetMood - smoothMood) * 0.04;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const diag = Math.hypot(cx, cy);
      // Intro: a wave front travels from the left over ~2.6 s, squares appear behind it.
      const introT = Math.min(1, t / 2.6);
      const front = introT * (w + 400) - 200;
      const base = 0.10 + smoothMood * 0.12;
      const amp = 0.22 + smoothLevel * 0.9 + smoothMood * 0.25;
      const speed = 0.9 + smoothMood * 2.2 + smoothLevel * 1.5;
      for (let j = 0; j < rows; j++) {
        const y = j * CELL;
        for (let i = 0; i < cols; i++) {
          const x = i * CELL;
          const dx = x - cx, dy = y - cy;
          const d = Math.hypot(dx, dy) / diag; // 0 centre … 1 corner
          // Two slow travelling waves + a radial ripple that breathes from the centre.
          const v1 = Math.sin(x * 0.012 - t * speed * 0.9 + y * 0.004);
          const v2 = Math.sin((x + y) * 0.007 + t * speed * 0.6);
          const ripple = Math.sin(d * 14 - t * speed * 1.6) * (0.35 + smoothMood * 0.5 + smoothLevel * 0.6);
          let v = base + amp * (0.5 + 0.5 * (0.55 * v1 + 0.3 * v2 + 0.5 * ripple)) * (1 - d * 0.55);
          // Intro envelope: bright crest at the front, settles behind it.
          if (introT < 1) {
            const dist = front - x;
            if (dist < 0) v = 0;
            else { const crest = Math.exp(-((dist - 80) * (dist - 80)) / 9000); v = v * Math.min(1, dist / 260) + crest * 0.95; }
          }
          if (v <= 0.02) continue;
          const k = Math.min(64, Math.max(0, Math.round(v * 64)));
          ctx.fillStyle = palette[k];
          ctx.globalAlpha = Math.min(1, 0.12 + v * 0.95);
          const s = SQUARE * (0.55 + Math.min(1, v) * 0.6);
          ctx.fillRect(x + (CELL - s) / 2, y + (CELL - s) / 2, s, s);
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden />;
}
