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

const LINE = /^\s*[-*]?\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*(.*)$/;

/** One card per line of the block; lines that are not a creative are ignored. */
export function parseCreativeBlock(text: string): CreativeCardData[] {
  const out: CreativeCardData[] = [];
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const parts = m[3].split("|").map((s) => s.trim()).filter(Boolean);
    const kpiPart = parts.length > 1 ? parts[parts.length - 1] : parts[0] ?? "";
    const caption = parts.length > 1 ? parts.slice(0, -1).join(" · ") : "";
    const kpis = kpiPart.split(/\s+·\s+|\s*;\s*/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const k = /^(.*?[^\d\s−+-])\s+([−+-]?\d.*)$/.exec(s);
      return k ? { label: k[1], value: k[2] } : { label: "", value: s };
    });
    out.push({ name: m[1].trim(), src: m[2], caption, kpis });
  }
  return out;
}

export function BotCreativeCards({ text }: { text: string }) {
  const cards = parseCreativeBlock(text);
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
