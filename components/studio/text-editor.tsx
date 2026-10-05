"use client";

/**
 * Studio créa — texts and logo laid over a visual by code, not by the AI: the
 * exact words (accents, dates, prices), a sharp logo from its real file, the
 * brand colors. Drawn on a canvas at the visual's own resolution, saved as a
 * new Studio image (kind "composite"), the visual itself untouched. No AI.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";

type Position = "top-left" | "top-center" | "center" | "bottom-left" | "bottom-center";
type Font = "Montserrat" | "Inter" | "Playfair Display";

export interface Layers {
  headline: string; subline: string; cta: string;
  position: Position; font: Font; uppercase: boolean;
  textColor: string; ctaBg: string; ctaColor: string;
  headlineSize: number; // % of the width
  shade: boolean;
  logo: string | null; logoSize: number; // % of the width
}

const DEFAULTS: Layers = {
  headline: "", subline: "", cta: "", position: "top-left", font: "Montserrat", uppercase: true,
  textColor: "#ffffff", ctaBg: "#ffffff", ctaColor: "#111111", headlineSize: 9, shade: true, logo: null, logoSize: 18,
};

const POSITIONS: Array<[Position, string]> = [["top-left", "Haut gauche"], ["top-center", "Haut centré"], ["center", "Centre"], ["bottom-left", "Bas gauche"], ["bottom-center", "Bas centré"]];
const FONTS: Font[] = ["Montserrat", "Inter", "Playfair Display"];
const WEIGHT: Record<Font, number> = { Montserrat: 800, Inter: 700, "Playfair Display": 700 };

function loadFonts() {
  if (document.getElementById("studio-fonts")) return;
  const link = document.createElement("link");
  link.id = "studio-fonts";
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@500;700&family=Montserrat:wght@600;800&family=Playfair+Display:wght@700&display=swap";
  document.head.appendChild(link);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) { out.push(line); line = word; } else line = test;
    }
    out.push(line);
  }
  return out.filter((l, i, all) => l || i < all.length - 1);
}

/** Draws the visual and the layers on `canvas` at the visual's resolution. */
export function drawComposition(canvas: HTMLCanvasElement, base: HTMLImageElement, logo: HTMLImageElement | null, L: Layers) {
  const W = base.naturalWidth, H = base.naturalHeight;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(base, 0, 0, W, H);
  const pad = Math.round(W * 0.06);
  const top = L.position.startsWith("top"), center = L.position === "center", centered = L.position.endsWith("center");

  if (L.shade && (L.headline || L.subline || L.cta)) {
    const g = center ? ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.6) : ctx.createLinearGradient(0, top ? 0 : H, 0, top ? H * 0.55 : H * 0.45);
    g.addColorStop(0, "rgba(0,0,0,0.55)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  const font = `"${L.font}", Arial, sans-serif`;
  const hSize = Math.round(W * (L.headlineSize / 100));
  const sSize = Math.round(hSize * 0.42);
  const cSize = Math.round(hSize * 0.38);
  const maxW = W - pad * 2 - (centered ? 0 : W * 0.1);
  ctx.textBaseline = "top";
  ctx.textAlign = centered ? "center" : "left";
  const x = centered ? W / 2 : pad;

  ctx.font = `${WEIGHT[L.font]} ${hSize}px ${font}`;
  const hLines = L.headline ? wrap(ctx, L.uppercase ? L.headline.toUpperCase() : L.headline, maxW) : [];
  ctx.font = `500 ${sSize}px ${font}`;
  const sLines = L.subline ? wrap(ctx, L.subline, maxW) : [];
  const ctaH = L.cta ? Math.round(cSize * 2.2) : 0;
  const blockH = hLines.length * hSize * 1.05 + (sLines.length ? sSize * 0.6 + sLines.length * sSize * 1.25 : 0) + (ctaH ? sSize * 0.9 + ctaH : 0);
  let y = top ? pad : center ? (H - blockH) / 2 : H - pad - blockH;

  ctx.fillStyle = L.textColor;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = Math.round(W * 0.01);
  ctx.font = `${WEIGHT[L.font]} ${hSize}px ${font}`;
  for (const l of hLines) { ctx.fillText(l, x, y); y += hSize * 1.05; }
  if (sLines.length) {
    y += sSize * 0.6;
    ctx.font = `500 ${sSize}px ${font}`;
    for (const l of sLines) { ctx.fillText(l, x, y); y += sSize * 1.25; }
  }
  ctx.shadowBlur = 0;
  if (L.cta) {
    y += sSize * 0.9;
    ctx.font = `700 ${cSize}px ${font}`;
    const tw = ctx.measureText(L.cta).width;
    const bw = tw + cSize * 2.4;
    const bx = centered ? (W - bw) / 2 : pad;
    const r = ctaH / 2;
    ctx.fillStyle = L.ctaBg;
    ctx.beginPath();
    ctx.roundRect(bx, y, bw, ctaH, r);
    ctx.fill();
    ctx.fillStyle = L.ctaColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(L.cta, bx + bw / 2, y + ctaH / 2);
  }

  if (logo) {
    const lw = Math.round(W * (L.logoSize / 100));
    const lh = Math.round(lw * (logo.naturalHeight / logo.naturalWidth));
    // Opposite corner from the texts.
    const lx = W - pad - lw;
    const ly = top || center ? H - pad - lh : pad;
    ctx.drawImage(logo, lx, ly, lw, lh);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image illisible"));
    img.src = src;
  });
}

export function TextEditor({ asset, onClose, onSaved }: {
  asset: { id: string; prompt: string; params: { ratio?: string } };
  onClose: () => void;
  onSaved: (asset: unknown) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [base, setBase] = useState<HTMLImageElement | null>(null);
  const [logoImg, setLogoImg] = useState<HTMLImageElement | null>(null);
  const [L, setL] = useState<Layers>(DEFAULTS);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const logoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadFonts();
    // Same origin (the app streams the file): the canvas can be exported.
    loadImage(`/api/studio/assets/${asset.id}/file?inline=1`).then(setBase).catch((e) => setError(e.message));
  }, [asset.id]);

  const redraw = useCallback(async () => {
    if (!base || !canvasRef.current) return;
    await document.fonts.load(`${WEIGHT[L.font]} 40px "${L.font}"`).catch(() => {});
    drawComposition(canvasRef.current, base, logoImg, L);
  }, [base, logoImg, L]);

  useEffect(() => { void redraw(); }, [redraw]);

  async function pickLogo(file: File | undefined) {
    if (!file) return;
    const url = await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsDataURL(file); });
    setLogoImg(await loadImage(url));
    setL((x) => ({ ...x, logo: file.name }));
  }

  async function save() {
    if (!canvasRef.current || !base) return;
    setSaving(true);
    setError(null);
    try {
      await redraw();
      const image = canvasRef.current.toDataURL("image/jpeg", 0.92);
      const res = await fetch("/api/studio/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "composite", sourceId: asset.id, image, prompt: `Composition : ${L.headline || L.subline || L.cta || "logo"} — sur « ${asset.prompt.slice(0, 120)} »`, layers: { ...L, logo: L.logo ? "oui" : null } }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.asset) throw new Error(j.error ?? `Erreur ${res.status}`);
      onSaved(j.asset);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const field = "w-full bg-gray-950 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-white outline-none focus:border-violet-500";
  const set = <K extends keyof Layers>(k: K, v: Layers[K]) => setL((x) => ({ ...x, [k]: v }));

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-950 border border-gray-800 rounded-2xl max-w-5xl w-full max-h-[94vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <span className="text-sm text-white font-semibold">Textes & logo — posés exactement, sans IA</span>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white" aria-label="Fermer"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 grid md:grid-cols-[minmax(0,1fr)_300px] gap-4">
          <div className="flex items-center justify-center bg-gray-900 rounded-lg min-h-[300px]">
            {base ? <canvas ref={canvasRef} className="max-w-full max-h-[75vh] h-auto w-auto rounded" /> : <Loader2 className="w-6 h-6 animate-spin text-gray-500" />}
          </div>
          <div className="space-y-3 text-xs text-gray-400">
            <label className="block">Titre<textarea value={L.headline} onChange={(e) => set("headline", e.target.value)} rows={2} className={`${field} mt-1 resize-y`} placeholder="ON FAIT ÉQUIPE TOUT L'HIVER" /></label>
            <label className="block">Sous-ligne<input value={L.subline} onChange={(e) => set("subline", e.target.value)} className={`${field} mt-1`} placeholder="Du 1er décembre au 31 janvier" /></label>
            <label className="block">Bouton (facultatif)<input value={L.cta} onChange={(e) => set("cta", e.target.value)} className={`${field} mt-1`} placeholder="J'en profite" /></label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">Position
                <select value={L.position} onChange={(e) => set("position", e.target.value as Position)} className={`${field} mt-1`}>{POSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </label>
              <label className="block">Police
                <select value={L.font} onChange={(e) => set("font", e.target.value as Font)} className={`${field} mt-1`}>{FONTS.map((f) => <option key={f} value={f}>{f}</option>)}</select>
              </label>
            </div>
            <label className="block">Taille du titre : {L.headlineSize} %<input type="range" min={4} max={16} value={L.headlineSize} onChange={(e) => set("headlineSize", Number(e.target.value))} className="w-full" /></label>
            <div className="grid grid-cols-3 gap-2">
              <label className="block">Texte<input type="color" value={L.textColor} onChange={(e) => set("textColor", e.target.value)} className="mt-1 w-full h-8 bg-transparent" /></label>
              <label className="block">Bouton<input type="color" value={L.ctaBg} onChange={(e) => set("ctaBg", e.target.value)} className="mt-1 w-full h-8 bg-transparent" /></label>
              <label className="block">Texte bouton<input type="color" value={L.ctaColor} onChange={(e) => set("ctaColor", e.target.value)} className="mt-1 w-full h-8 bg-transparent" /></label>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={L.uppercase} onChange={(e) => set("uppercase", e.target.checked)} /> Titre en majuscules</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={L.shade} onChange={(e) => set("shade", e.target.checked)} /> Ombre derrière le texte</label>
            </div>
            <div>
              <span>Logo (PNG transparent de préférence)</span>
              <div className="flex items-center gap-2 mt-1">
                <button type="button" onClick={() => logoRef.current?.click()} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-gray-800 text-gray-300 hover:text-white"><ImagePlus className="w-4 h-4" /> {L.logo ? "Changer" : "Ajouter"}</button>
                {L.logo && <button type="button" onClick={() => { setLogoImg(null); set("logo", null); }} className="text-gray-500 hover:text-white">Retirer</button>}
              </div>
              <input ref={logoRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(e) => { void pickLogo(e.target.files?.[0]); e.target.value = ""; }} />
              {L.logo && <label className="block mt-2">Taille du logo : {L.logoSize} %<input type="range" min={8} max={40} value={L.logoSize} onChange={(e) => set("logoSize", Number(e.target.value))} className="w-full" /></label>}
            </div>
            {error && <p className="text-sm text-red-300">{error}</p>}
            <button type="button" onClick={() => void save()} disabled={saving || !base} className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-sm text-white font-medium">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />} Enregistrer dans le Studio
            </button>
            <p className="text-[11px] text-gray-500">Une nouvelle image est créée ; le visuel d&apos;origine reste intact.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
