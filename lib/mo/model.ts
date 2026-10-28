/**
 * Mo — the voice assistant of the staff (/mo). A session is a BOARD: an
 * infinite canvas of floating cards. Mo never answers in prose: each turn it
 * returns one short sentence to say out loud and a few cards to put on the
 * board (tables, KPIs, charts, creatives, notes). The browser speaks the
 * sentence and lays the cards next to the previous ones.
 *
 * This module is client-safe (types + pure parsing); storage is in ./thread.
 */

export type MoCardType = "kpis" | "table" | "chart" | "creatives" | "note";
export type MoTone = "good" | "bad" | "neutral";

export interface MoKpi { label: string; value: string; delta?: string; tone?: MoTone; hint?: string }
/** One visual on a creatives card. `adId` (platform ad) or `assetId` (Studio/Mo asset) ties it to what the tools know; `link` opens it (Drive, platform). */
export interface MoCreative { name: string; image?: string; metrics: Record<string, string>; note?: string; adId?: string; assetId?: string; link?: string }
export interface MoSeries { name: string; values: Array<number | null> }

interface MoCardBase {
  id: string;
  title: string;
  /** Period / source line under the title ("Meta · Naturalia · 24 oct"). */
  subtitle?: string;
  /** Id of the card this one compares with or follows (drawn as a link). */
  ref?: string;
  /** World coordinates and size on the board. */
  x: number;
  y: number;
  w: number;
  h?: number;
  /** Stacking order (higher on top); set when a card is brought to the front. */
  z?: number;
  minimized?: boolean;
  /** Turn that produced the card (index of the assistant message). */
  turn: number;
  at: string;
}

/** The content of a card, by type. */
export type MoCardPayload =
  | { type: "kpis"; items: MoKpi[] }
  | { type: "table"; columns: string[]; rows: string[][]; align?: Array<"left" | "right"> }
  | { type: "chart"; kind: "line" | "bar"; x: string[]; series: MoSeries[]; unit?: string }
  | { type: "creatives"; items: MoCreative[] }
  | { type: "note"; markdown: string };

export type MoCard = MoCardBase & MoCardPayload;

/** What the model writes for one card (before it gets an id and a place). */
export type MoCardSpec = { title: string; subtitle?: string; ref?: string } & MoCardPayload;

/** A card already on the board rewritten by the model: same id and place, new content (and title when given). */
export type MoCardUpdate = { id: string; title?: string; subtitle?: string } & (MoCardPayload | { type?: undefined });

/** Geometry patch sent by the browser. */
export interface MoCardPatch { x?: number; y?: number; w?: number; h?: number; z?: number; minimized?: boolean; removed?: boolean }

export interface MoMessage {
  role: "user" | "assistant";
  /** What was said (user) or Mo's raw answer (assistant, the ```mo block included). */
  content: string;
  at: string;
  /** Assistant: the spoken sentence and the cards the turn produced. */
  say?: string;
  cardIds?: string[];
  /** Assistant: the page of the app Mo opened for the person ("/analyse?client=…"). */
  open?: string;
}

export interface MoBoardData {
  id: string;
  title: string;
  cards: MoCard[];
  messages: MoMessage[];
  updatedAt: string;
}

export const MO_MAX_CARDS = 120;
export const MO_MAX_MESSAGES = 80;
export const moSessionKey = (boardId: string) => `mo:${boardId}`;

/** Default size of a card by type (world units = CSS px at zoom 1). */
export const CARD_SIZES: Record<MoCardType, { w: number; h: number }> = {
  kpis: { w: 440, h: 220 },
  table: { w: 640, h: 380 },
  chart: { w: 560, h: 360 },
  creatives: { w: 660, h: 440 },
  note: { w: 440, h: 320 },
};

export const ROW_GAP = 70;
export const COL_GAP = 40;
/** A turn's cards wrap to a new row beyond this width (world px), so a fit stays legible. */
export const ROW_WRAP_WIDTH = 1400;

/** What the model is asked to produce (parsed by `parseMoAnswer`). */
export interface MoAnswer { say: string; cards: MoCardSpec[]; open?: string; updates: MoCardUpdate[]; remove: string[] }

const CARD_ID_RE = /^[a-z0-9]{3,24}$/i;

/** An image a card may show: an https link given by a tool, or a file of the application itself (/api/studio/assets/<id>/file). */
export function cardImageOk(v: string): boolean {
  return /^https:\/\//.test(v) || /^\/api\/studio\/assets\/[A-Za-z0-9_-]{6,40}\/file(\?inline=1)?$/.test(v) || /^\/api\/mo\/ad-image\/(meta|google|tiktok|linkedin)\/[A-Za-z0-9_-]{3,40}$/.test(v);
}

/**
 * Pages Mo may open by voice (prefixes). Anything else in « open » is dropped:
 * the model never sends the browser outside the app or into the admin.
 */
export const MO_OPEN_PREFIXES = ["/cockpit", "/portfolio", "/analyse", "/d", "/reports", "/pilotage", "/design", "/studio", "/creas", "/dashboards", "/routines", "/me/alerts", "/me/budgets", "/ai", "/bot", "/mo"] as const;

/** A path of the app the browser may navigate to, or null. Relative, no host, no admin, printable characters only. */
export function sanitizeOpen(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const path = v.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 300) return null;
  if (!/^\/[A-Za-z0-9\-_./?=&%:+,]*$/.test(path)) return null;
  const base = path.split(/[?#]/)[0];
  return MO_OPEN_PREFIXES.some((p) => base === p || base.startsWith(`${p}/`)) ? path : null;
}

const MAX_SAY = 400;
const MAX_TITLE = 90;
const MAX_ROWS = 60;
const MAX_COLS = 10;
const MAX_ITEMS = 24;
const MAX_POINTS = 120;
const MAX_MD = 6000;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").trim().slice(0, max);
const tone = (v: unknown): MoTone | undefined => (v === "good" || v === "bad" || v === "neutral" ? v : undefined);

function sanitizeCard(raw: unknown): MoCardSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, MAX_TITLE) || "Sans titre";
  const subtitle = str(r.subtitle, 160) || undefined;
  const ref = /^[a-z0-9]{3,24}$/i.test(String(r.ref ?? "")) ? String(r.ref) : undefined;
  const base = { title, ...(subtitle ? { subtitle } : {}), ...(ref ? { ref } : {}) };
  switch (r.type) {
    case "kpis": {
      const items = (Array.isArray(r.items) ? r.items : []).slice(0, MAX_ITEMS).map((it): MoKpi | null => {
        if (!it || typeof it !== "object") return null;
        const k = it as Record<string, unknown>;
        const label = str(k.label, 60); const value = str(k.value, 40);
        if (!label || !value) return null;
        const delta = str(k.delta, 30); const hint = str(k.hint, 120);
        return { label, value, ...(delta ? { delta } : {}), ...(tone(k.tone) ? { tone: tone(k.tone) } : {}), ...(hint ? { hint } : {}) };
      }).filter((x): x is MoKpi => !!x);
      return items.length ? { ...base, type: "kpis", items } : null;
    }
    case "table": {
      const columns = (Array.isArray(r.columns) ? r.columns : []).slice(0, MAX_COLS).map((c) => str(c, 60));
      if (!columns.length) return null;
      const rows = (Array.isArray(r.rows) ? r.rows : []).slice(0, MAX_ROWS)
        .map((row) => (Array.isArray(row) ? row : []).slice(0, columns.length).map((c) => str(c, 160)))
        .filter((row) => row.some(Boolean))
        .map((row) => { while (row.length < columns.length) row.push(""); return row; });
      const align = Array.isArray(r.align) ? r.align.slice(0, columns.length).map((a) => (a === "right" ? "right" as const : "left" as const)) : undefined;
      return { ...base, type: "table", columns, rows, ...(align ? { align } : {}) };
    }
    case "chart": {
      const kind = r.kind === "bar" ? "bar" as const : "line" as const;
      const x = (Array.isArray(r.x) ? r.x : []).slice(0, MAX_POINTS).map((v) => str(v, 40));
      const series = (Array.isArray(r.series) ? r.series : []).slice(0, 6).map((s): MoSeries | null => {
        if (!s || typeof s !== "object") return null;
        const o = s as Record<string, unknown>;
        const values = (Array.isArray(o.values) ? o.values : []).slice(0, x.length).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(",", "."))) ? Number(v.replace(",", ".")) : null));
        return values.length ? { name: str(o.name, 40) || "Série", values } : null;
      }).filter((s): s is MoSeries => !!s);
      if (!x.length || !series.length) return null;
      const unit = str(r.unit, 10);
      return { ...base, type: "chart", kind, x, series, ...(unit ? { unit } : {}) };
    }
    case "creatives": {
      const items = (Array.isArray(r.items) ? r.items : []).slice(0, MAX_ITEMS).map((it): MoCreative | null => {
        if (!it || typeof it !== "object") return null;
        const k = it as Record<string, unknown>;
        const name = str(k.name, 120);
        if (!name) return null;
        const image = str(k.image, 1500);
        const metrics: Record<string, string> = {};
        if (k.metrics && typeof k.metrics === "object") for (const [mk, mv] of Object.entries(k.metrics as Record<string, unknown>).slice(0, 8)) { const key = str(mk, 30); const val = str(mv, 40); if (key && val) metrics[key] = val; }
        const note = str(k.note, 200);
        const adId = str(k.adId, 40); const assetId = str(k.assetId, 40); const link = str(k.link, 500);
        return { name, ...(cardImageOk(image) ? { image } : {}), metrics, ...(note ? { note } : {}), ...(/^[\w:-]+$/.test(adId) ? { adId } : {}), ...(/^[\w-]+$/.test(assetId) ? { assetId } : {}), ...(/^https:\/\//.test(link) ? { link } : {}) };
      }).filter((x): x is MoCreative => !!x);
      return items.length ? { ...base, type: "creatives", items } : null;
    }
    case "note": {
      const markdown = str(r.markdown ?? r.text ?? r.content, MAX_MD);
      return markdown ? { ...base, type: "note", markdown } : null;
    }
    default:
      return null;
  }
}

/**
 * Reads Mo's answer: the JSON of the ```mo fence (or the whole text when it
 * is bare JSON). Without a usable block, the text becomes one note card and
 * the first sentence is what gets said — so a stray prose answer still lands
 * on the board.
 */
export function parseMoAnswer(text: string): MoAnswer {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:mo|json)?\s*\n([\s\S]*?)\n```/);
  const candidates = [fence?.[1], trimmed].filter((c): c is string => !!c);
  for (const c of candidates) {
    let parsed: unknown;
    try { parsed = JSON.parse(c); } catch { continue; }
    if (!parsed || typeof parsed !== "object") continue;
    const o = parsed as Record<string, unknown>;
    const cards = (Array.isArray(o.cards) ? o.cards : []).map(sanitizeCard).filter((x): x is MoCardSpec => !!x).slice(0, 8);
    const updates = (Array.isArray(o.update) ? o.update : Array.isArray(o.updates) ? o.updates : []).map(sanitizeUpdate).filter((x): x is MoCardUpdate => !!x).slice(0, 8);
    const remove = (Array.isArray(o.remove) ? o.remove : []).map((v) => String(v ?? "")).filter((v) => CARD_ID_RE.test(v)).slice(0, 24);
    const open = sanitizeOpen(o.open);
    const say = str(o.say, MAX_SAY) || (cards.length ? `Voilà, ${cards.length === 1 ? "la carte est" : "les cartes sont"} à l'écran.` : updates.length ? "C'est mis à jour à l'écran." : open ? "J'ouvre la page." : "Je n'ai rien trouvé à afficher.");
    return { say, cards, updates, remove, ...(open ? { open } : {}) };
  }
  // Prose fallback.
  const outside = trimmed.replace(/```[\s\S]*?```/g, "").trim();
  const firstSentence = outside.split(/(?<=[.!?])\s/)[0]?.slice(0, MAX_SAY) || "Voilà ce que j'ai trouvé.";
  return { say: firstSentence, cards: outside ? [{ type: "note", title: "Réponse de Mo", markdown: outside.slice(0, MAX_MD) }] : [], updates: [], remove: [] };
}

/** An « update » entry: the id of a card on the board, then either a whole new content (with `type`) or just a new title / subtitle. */
function sanitizeUpdate(raw: unknown): MoCardUpdate | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "");
  if (!CARD_ID_RE.test(id)) return null;
  if (r.type !== undefined) {
    const spec = sanitizeCard({ ...r, title: r.title ?? "·" });
    if (!spec) return null;
    const { title, subtitle, ref: _ref, ...payload } = spec; void _ref;
    return { id, ...(typeof r.title === "string" && title !== "·" ? { title } : {}), ...(subtitle ? { subtitle } : {}), ...payload } as MoCardUpdate;
  }
  const title = str(r.title, MAX_TITLE); const subtitle = str(r.subtitle, 160);
  if (!title && !subtitle) return null;
  return { id, ...(title ? { title } : {}), ...(subtitle ? { subtitle } : {}) };
}

/** The cards of the board after the model's updates and removals (geometry kept; an unknown id is ignored). Returns the ids actually touched. */
export function applyCardUpdates(cards: MoCard[], answer: Pick<MoAnswer, "updates" | "remove">, turn: number, at: string): { cards: MoCard[]; touched: string[] } {
  const removed = new Set(answer.remove);
  const byId = new Map(answer.updates.map((u) => [u.id, u]));
  const touched: string[] = [];
  const out: MoCard[] = [];
  for (const c of cards) {
    if (removed.has(c.id)) { touched.push(c.id); continue; }
    const u = byId.get(c.id);
    if (!u) { out.push(c); continue; }
    touched.push(c.id);
    const { id: _id, title, subtitle, ...rest } = u; void _id;
    const base = { id: c.id, x: c.x, y: c.y, w: c.w, ...(c.h ? { h: c.h } : {}), ...(c.z !== undefined ? { z: c.z } : {}), ...(c.ref ? { ref: c.ref } : {}), minimized: false, turn, at, title: title ?? c.title, ...(subtitle ? { subtitle } : c.subtitle ? { subtitle: c.subtitle } : {}) };
    if ("type" in rest && rest.type) {
      // New content: same size unless the type changed (then the default size of the new type).
      const size = rest.type === c.type ? { w: c.w, h: c.h } : CARD_SIZES[rest.type];
      out.push({ ...base, ...rest, w: size.w, ...(size.h ? { h: size.h } : {}) } as MoCard);
    } else {
      const { x: _x, y: _y, w: _w, h: _h, z: _z, ref: _r, minimized: _m, turn: _t, at: _a, title: _ti, subtitle: _su, id: _i, ...payload } = c; void [_x, _y, _w, _h, _z, _r, _m, _t, _a, _ti, _su, _i];
      out.push({ ...base, ...payload } as MoCard);
    }
  }
  return { cards: out, touched };
}

/** Places the cards of one turn on new rows under everything already on the board (rows wrap at ROW_WRAP_WIDTH), on top of the stack. */
export function layoutNewCards(existing: MoCard[], answer: { cards: MoCardSpec[]; say?: string; open?: string; updates?: MoCardUpdate[]; remove?: string[] }, turn: number, at: string): MoCard[] {
  const bottom = existing.reduce((m, c) => Math.max(m, c.y + (c.h ?? CARD_SIZES[c.type].h)), 0);
  let y = existing.length ? bottom + ROW_GAP : 0;
  let x = 0, rowH = 0;
  let z = existing.reduce((m, c) => Math.max(m, c.z ?? 0), 0);
  const ids = new Set(existing.map((c) => c.id));
  const out: MoCard[] = [];
  for (const c of answer.cards) {
    const size = CARD_SIZES[c.type];
    if (x > 0 && x + size.w > ROW_WRAP_WIDTH) { y += rowH + ROW_GAP; x = 0; rowH = 0; }
    let id = newCardId();
    while (ids.has(id)) id = newCardId();
    ids.add(id);
    const ref = c.ref && ids.has(c.ref) ? c.ref : undefined;
    const { ref: _ref, ...rest } = c; void _ref;
    z += 1;
    out.push({ ...rest, ...(ref ? { ref } : {}), id, x, y, w: size.w, h: size.h, z, turn, at } as MoCard);
    x += size.w + COL_GAP;
    rowH = Math.max(rowH, size.h);
  }
  return out;
}

export function newCardId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Compact inventory of the board for the model: id, type, title, and what the
 * card holds (names and ids of the creatives, columns of a table, labels of
 * the KPIs) so « mets les chiffres sous chaque créa » can rewrite the right card.
 */
export function describeCards(cards: MoCard[]): string {
  const visible = cards.slice(-24);
  if (!visible.length) return "Aucune carte à l'écran pour l'instant.";
  const detail = (c: MoCard): string => {
    switch (c.type) {
      case "creatives": return ` — visuels : ${c.items.slice(0, 12).map((it) => `${it.name}${it.adId ? ` [ad ${it.adId}]` : it.assetId ? ` [asset ${it.assetId}]` : ""}`).join(" ; ")}${c.items.length > 12 ? ` ; +${c.items.length - 12}` : ""}`;
      case "table": return ` — colonnes : ${c.columns.join(", ")} (${c.rows.length} lignes)`;
      case "kpis": return ` — ${c.items.map((k) => `${k.label} ${k.value}`).join(", ")}`;
      case "chart": return ` — ${c.series.map((s) => s.name).join(", ")} sur ${c.x.length} points`;
      case "note": return "";
    }
  };
  return visible.map((c) => `- ${c.id} · ${c.type} · « ${c.title} »${c.subtitle ? ` (${c.subtitle})` : ""}${detail(c)}`).join("\n");
}

export function boardTitleFrom(messages: MoMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.content.replace(/\s+/g, " ").trim() ?? "";
  return first.length > 60 ? first.slice(0, 59).trimEnd() + "…" : first || "Session Mo";
}
