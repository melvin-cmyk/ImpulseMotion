"use client";

/**
 * Creative cards of a client bot's reply (the Analyse Ads card, Motion-like):
 * the assistant writes a ```creas block, one line per creative —
 *   ![Nom de la créa](/api/bot/<id>/image?ad=…) | Vidéo · lancée le 09/07 | dépense 1 136 € · CTR 2 % · ROAS 4,95
 * — and the chat lays them out as a grid: uncropped visual (video player for
 * Meta videos), name, caption, then « label | value » rows. Only the bot's
 * own media addresses are loaded (BotCardMedia, components/ai/safe-image).
 */

import { BotCardMedia } from "@/components/ai/safe-image";

export interface CreativeCardData { name: string; src: string; caption: string; kpis: Array<{ label: string; value: string }> }

// « carte : » is the label the prompt puts before the line to copy: the model sometimes copies it too.
const IMG_LINE = /^\s*(?:[-*•]|\d+[.)])?\s*(?:carte\s*:\s*)?!\[([^\]]*)\]\(([^)\s]+)\)\s*(.*)$/;
// The bot's own address written with a raw name in it (spaces, parentheses): up to the « ) » that ends the line or precedes « | ».
const LOOSE_IMG_LINE = /^\s*(?:[-*•]|\d+[.)])?\s*(?:carte\s*:\s*)?!\[([^\]]*)\]\((\/api\/bot\/.+?)\)\s*(\|.*)?$/;

/** The value of ?ad= / ?name= re-encoded when the model wrote it raw (spaces, accents, « & »). */
function cleanSrc(src: string): string {
  const m = /^(\/api\/bot\/[\w-]+\/(?:image|video)\?(?:ad|name)=)(.*?)(&product=\d)?$/.exec(src);
  if (!m) return src;
  let v = m[2];
  try { v = decodeURIComponent(v); } catch { /* raw « % » : kept as written */ }
  return `${m[1]}${encodeURIComponent(v)}${m[3] ?? ""}`;
}

// « Nom | chiffres » or « Nom — chiffres » (em / en dash only: names often contain « - »)
const TEXT_LINE = /^\s*(?:[-*•]|\d+[.)])?\s*(.+?)\s*(?:\||—|–)\s*(.*\d.*)$/;

function kpisOf(part: string) {
  return part.split(/\s+·\s+|\s*;\s*/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const k = /^(.*?[^\d\s−+-])\s*:?\s+([−+-]?\d.*)$/.exec(s);
    return k ? { label: k[1].replace(/:$/, ""), value: k[2] } : { label: "", value: s };
  });
}

/**
 * One card per line of the block; lines that are not a creative are ignored.
 * A line with no visual (« Nom | Vidéo · lancée le 09/07 | dépense … ») gets
 * the visual of the ad of that name on the bot's accounts (?name=).
 */
// Lines of the prompt's creative entries the model may copy along: never a card.
const META_LINE = /^\s*(?:texte|chiffres|type|format|thème|theme|publicité dynamique|carte)\s*:/i;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function parseCreativeBlock(text: string, botId?: string): CreativeCardData[] {
  const out: Array<CreativeCardData & { byName?: boolean }> = [];
  for (const raw of text.split("\n")) {
    let name = "", src = "", rest = "";
    const m = IMG_LINE.exec(raw) ?? LOOSE_IMG_LINE.exec(raw);
    if (m) { name = m[1]; src = cleanSrc(m[2]); rest = m[3] ?? ""; }
    else if (META_LINE.test(raw)) continue;
    else {
      const t = botId ? TEXT_LINE.exec(raw) : null;
      if (!t) continue;
      name = t[1].replace(/\*+/g, "").trim().replace(/^[«"“]\s*|\s*[»"”]$/g, "").trim();
      if (!name || /^[-:\s]+$/.test(name) || /^(nom|créa|creative)$/i.test(name)) continue;
      src = `/api/bot/${encodeURIComponent(botId!)}/image?name=${encodeURIComponent(name)}`;
      rest = `| ${t[2]}`;
    }
    const parts = rest.split("|").map((s) => s.trim()).filter(Boolean);
    const kpiPart = parts.length > 1 ? parts[parts.length - 1] : parts[0] ?? "";
    const caption = parts.length > 1 ? parts.slice(0, -1).join(" · ") : "";
    out.push({ name: name.trim(), src, caption, kpis: kpisOf(kpiPart), ...(m ? {} : { byName: true }) });
  }
  // A line found by name that repeats a creative already shown with its visual
  // (the « 1. « Nom » — Image… » heading copied with its card) is dropped.
  const shown = out.filter((c) => !c.byName).map((c) => norm(c.name)).filter((n) => n.length >= 6);
  return out
    .filter((c) => !c.byName || !shown.some((n) => { const k = norm(c.name); return k.length >= 6 && (n.startsWith(k) || k.startsWith(n)); }))
    .map(({ byName: _b, ...c }) => { void _b; return c; });
}

/** Does this code block look like a list of creatives (whatever its language tag)? */
export function looksLikeCreatives(text: string, lang: string): boolean {
  if (/^(creas|créas|creatives?|cards?|cartes?)$/i.test(lang)) return true;
  const lines = text.split("\n").filter((l) => l.trim());
  const media = lines.filter((l) => /!\[[^\]]*\]\(\/api\/bot\//.test(l)).length;
  return media > 0 && media >= Math.ceil(lines.length / 2);
}

export function BotCreativeCards({ text, botId }: { text: string; botId?: string }) {
  const cards = parseCreativeBlock(text, botId);
  if (!cards.length) return null;
  return (
    <div className="not-prose my-4 grid grid-cols-2 lg:grid-cols-3 gap-3">
      {cards.map((c, i) => (
        <div key={`${c.src}-${i}`} className="rounded-xl border border-ui-line bg-ui-card overflow-hidden flex flex-col min-w-0">
          <div className="aspect-[4/5] bg-ui-raised flex items-center justify-center overflow-hidden">
            <BotCardMedia src={c.src} alt={c.name} />
          </div>
          <div className="px-3 pt-2 pb-3 space-y-2 min-w-0">
            <div className="min-w-0">
              <div className="text-sm font-medium text-ui-fg truncate" title={c.name}>{c.name}</div>
              {c.caption && <div className="text-xs text-ui-muted truncate" title={c.caption}>{c.caption}</div>}
            </div>
            {c.kpis.length > 0 && (
              <div className="space-y-1">
                {c.kpis.map((k, j) => (
                  <div key={j} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="text-ui-muted truncate">{k.label}</span>
                    <span className="font-mono tabular-nums text-ui-fg shrink-0">{k.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
