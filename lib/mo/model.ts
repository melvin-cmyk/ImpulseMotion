/**
 * Mo — the voice assistant of the staff (/mo). A session is a BOARD: an
 * infinite canvas of floating cards. Mo never answers in prose: each turn it
 * returns one short sentence to say out loud and a few cards to put on the
 * board (tables, KPIs, charts, creatives, notes). The browser speaks the
 * sentence and lays the cards next to the previous ones.
 *
 * This module is client-safe (types + pure parsing); storage is in ./thread.
 */

export type MoCardType = "kpis" | "table" | "chart" | "creatives" | "note" | "ask" | "file" | "action" | "frame";
export type MoTone = "good" | "bad" | "neutral";
/** The consultant's verdict on a visual: kept (green) or cut (grey). */
export type MoVerdict = "keep" | "cut";

export interface MoKpi { label: string; value: string; delta?: string; tone?: MoTone; hint?: string }
/**
 * One visual on a creatives card. `adId` (platform ad, or `adlib:<id>` for the
 * Ad Library) or `assetId` (Studio/Mo asset) ties it to what the tools know;
 * `link` opens it (Drive, platform); `verdict` is the consultant's keep / cut
 * (also written on the CreativeAsset, or kept as a template for a warehouse ad:
 * `templateId`).
 */
export interface MoCreative { name: string; image?: string; metrics: Record<string, string>; note?: string; adId?: string; assetId?: string; link?: string; verdict?: MoVerdict; templateId?: string }
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
  /** The client the card is about (registry id, lib/clients/registry.ts) when a tool or an action knows it. */
  clientId?: string;
  clientName?: string;
  /** The client frame (card of type « frame ») this card lives in; moves with it, hidden when it is folded. */
  frame?: string;
  /** Where the card was exported (https): a Google Sheet of its rows, for instance — shown as a chip in the header. */
  link?: string;
  /** What the link opens (« Google Sheet »). */
  linkLabel?: string;
  /** The fabrique de statics this card belongs to (copies to validate, visuals generated): what « valide 1 à 5 » acts on. */
  runId?: string;
}

/** A publication prepared by Mo (Pilotage draft): confirmed by a click, never sent otherwise. */
export interface MoPublishAction {
  kind: "publish";
  /** Pilotage action id (PilotAction) of the prepared draft. */
  actionId: string;
  status: "to_confirm" | "sent" | "failed";
  assetId: string;
  image?: string;
  account: string;
  adset: string;
  adsetId: string;
  page: string;
  pageId?: string;
  name: string;
  primaryText: string;
  headline?: string;
  linkUrl: string;
  cta?: string;
  /** Where the texts come from when the person gave none (« repris de la créa « X » »). */
  textsFrom?: string;
  writesOpen: boolean;
  hq: string;
  /** Meta ad id once created (PAUSED). */
  adId?: string;
  error?: string;
  pilotage: string;
}

/** The content of a card, by type. */
export type MoCardPayload =
  | { type: "kpis"; items: MoKpi[] }
  | { type: "table"; columns: string[]; rows: string[][]; align?: Array<"left" | "right"> }
  | { type: "chart"; kind: "line" | "bar"; x: string[]; series: MoSeries[]; unit?: string }
  | { type: "creatives"; items: MoCreative[] }
  | { type: "note"; markdown: string }
  /** Mo hesitates between readings: a question and 2-4 options to click (the click is the next message). */
  | { type: "ask"; question: string; options: string[] }
  /** A file dropped on the board: a visual (kept as a CreativeAsset, copied in the client's Drive « Créas ») or a brief (Drive « Briefs »). */
  | { type: "file"; name: string; mime: string; bytes?: number; image?: string; link?: string; assetId?: string; folder?: "creas" | "briefs" }
  /** Something to confirm: a publication prepared through the Pilotage. */
  | ({ type: "action" } & MoPublishAction)
  /** A client frame: a named zone of the board (lib/mo/frames.ts) the client's cards are laid in; never written by the model. */
  | { type: "frame"; clientId: string; clientName: string; color: string };

export type MoCard = MoCardBase & MoCardPayload;

/** What the model writes for one card (before it gets an id and a place). */
export type MoCardSpec = { title: string; subtitle?: string; ref?: string; clientId?: string; clientName?: string; runId?: string } & MoCardPayload;

/** A card already on the board rewritten by the model: same id and place, new content (and title when given). */
export type MoCardUpdate = { id: string; title?: string; subtitle?: string } & (MoCardPayload | { type?: undefined });

/** Geometry patch sent by the browser. */
export interface MoCardPatch { x?: number; y?: number; w?: number; h?: number; z?: number; minimized?: boolean; removed?: boolean; /** Joins a frame (its id) or leaves it (null). */ frame?: string | null }

/** What the consultant did on the board without the model (journal, lib/mo/act.ts). */
export type MoActionKind = "verdict" | "creative_metrics" | "open_editor" | "drive" | "competitor_ads" | "publish_prepare" | "publish_confirm" | "upload" | "sheet";
export const MO_ACTION_KINDS: readonly MoActionKind[] = ["verdict", "creative_metrics", "open_editor", "drive", "competitor_ads", "publish_prepare", "publish_confirm", "upload", "sheet"];
export interface MoActionMeta { kind: MoActionKind; clientId?: string; cardIds: string[]; label: string; at: string }

export interface MoMessage {
  /** « action » = a line of the journal (a verdict, a publication, a file): never sent to the model (see `modelHistory`). */
  role: "user" | "assistant" | "action";
  /** What was said (user), Mo's raw answer (assistant, the ```mo block included) or the action's label (action). */
  content: string;
  at: string;
  /** Assistant: the spoken sentence and the cards the turn produced. */
  say?: string;
  cardIds?: string[];
  /** Assistant: the page of the app Mo opened for the person ("/analyse?client=…"). */
  open?: string;
  /** Action: what was done. */
  action?: MoActionMeta;
}

/** A message the model may see (what was said, what Mo answered): the journal's action lines are left out. */
export type MoChatMessage = MoMessage & { role: "user" | "assistant" };
export const modelHistory = (messages: MoMessage[]): MoChatMessage[] => messages.filter((m): m is MoChatMessage => m.role === "user" || m.role === "assistant");

/** Every entry of a board's journal, read from its JSON with caps (unknown shapes dropped). */
export function parseMoEntries(json: string | null | undefined): MoMessage[] {
  if (!json) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: MoMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    if ((r.role !== "user" && r.role !== "assistant" && r.role !== "action") || typeof r.content !== "string") continue;
    const action = r.role === "action" ? sanitizeActionMeta(r.action) : null;
    if (r.role === "action" && !action) continue;
    out.push({
      role: r.role,
      content: r.content,
      at: typeof r.at === "string" ? r.at : new Date(0).toISOString(),
      ...(typeof r.say === "string" ? { say: r.say } : {}),
      ...(Array.isArray(r.cardIds) ? { cardIds: r.cardIds.filter((x): x is string => typeof x === "string") } : {}),
      ...(typeof r.open === "string" ? { open: r.open } : {}),
      ...(action ? { action } : {}),
    });
  }
  return out.slice(-MO_MAX_MESSAGES);
}

function sanitizeActionMeta(raw: unknown): MoActionMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!(MO_ACTION_KINDS as readonly string[]).includes(String(r.kind))) return null;
  const clientId = typeof r.clientId === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(r.clientId) ? r.clientId : undefined;
  return { kind: r.kind as MoActionKind, ...(clientId ? { clientId } : {}), cardIds: (Array.isArray(r.cardIds) ? r.cardIds : []).filter((x): x is string => typeof x === "string").slice(0, 24), label: typeof r.label === "string" ? r.label.slice(0, 200) : "", at: typeof r.at === "string" ? r.at : new Date(0).toISOString() };
}

export interface MoBoardData {
  id: string;
  title: string;
  /** Page of the workspace: « Aujourd'hui » (home), a client's page, or a free page (lib/mo/pages.ts). */
  kind: "home" | "client" | "free";
  clientId: string | null;
  archived: boolean;
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
  ask: { w: 440, h: 200 },
  file: { w: 300, h: 380 },
  action: { w: 560, h: 700 },
  frame: { w: 1168, h: 320 },
};

export const ROW_GAP = 70;
export const COL_GAP = 40;
/** A turn's cards wrap to a new row beyond this width (world px), so a fit stays legible. */
export const ROW_WRAP_WIDTH = 1400;

/** The question Mo asks when it hesitates between two readings (client, period, platform). */
export interface MoAsk { question: string; options: string[] }

/** What the model is asked to produce (parsed by `parseMoAnswer`). */
export interface MoAnswer { say: string; cards: MoCardSpec[]; open?: string; updates: MoCardUpdate[]; remove: string[]; ask?: MoAsk }

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
const MAX_ASK_OPTIONS = 4;
const MAX_ASK_OPTION = 60;
const MAX_ASK_QUESTION = 200;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").trim().slice(0, max);

/** The export link of a card: https only, printable, 500 chars at most; undefined otherwise. */
export function sanitizeCardLink(v: unknown): string | undefined {
  const link = str(v, 500);
  return /^https:\/\/[^\s"'<>]+$/.test(link) ? link : undefined;
}
const tone = (v: unknown): MoTone | undefined => (v === "good" || v === "bad" || v === "neutral" ? v : undefined);

function sanitizeCard(raw: unknown): MoCardSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title, MAX_TITLE) || "Sans titre";
  const subtitle = str(r.subtitle, 160) || undefined;
  const ref = /^[a-z0-9]{3,24}$/i.test(String(r.ref ?? "")) ? String(r.ref) : undefined;
  const clientId = /^[A-Za-z0-9_-]{1,40}$/.test(String(r.clientId ?? "")) ? String(r.clientId) : undefined;
  const clientName = str(r.clientName, 80) || undefined;
  const link = sanitizeCardLink(r.link);
  const linkLabel = link ? str(r.linkLabel, 40) || undefined : undefined;
  const base = { title, ...(subtitle ? { subtitle } : {}), ...(ref ? { ref } : {}), ...(clientId ? { clientId } : {}), ...(clientName ? { clientName } : {}), ...(link ? { link } : {}), ...(linkLabel ? { linkLabel } : {}) };
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
        const adId = str(k.adId, 40); const assetId = str(k.assetId, 40); const link = str(k.link, 500); const templateId = str(k.templateId, 40);
        const verdict = k.verdict === "keep" || k.verdict === "cut" ? k.verdict : undefined;
        return { name, ...(cardImageOk(image) ? { image } : {}), metrics, ...(note ? { note } : {}), ...(/^[\w:-]+$/.test(adId) ? { adId } : {}), ...(/^[\w-]+$/.test(assetId) ? { assetId } : {}), ...(/^https:\/\//.test(link) ? { link } : {}), ...(verdict ? { verdict } : {}), ...(/^[\w-]+$/.test(templateId) ? { templateId } : {}) };
      }).filter((x): x is MoCreative => !!x);
      return items.length ? { ...base, type: "creatives", items } : null;
    }
    case "note": {
      const markdown = str(r.markdown ?? r.text ?? r.content, MAX_MD);
      return markdown ? { ...base, type: "note", markdown } : null;
    }
    case "ask": {
      const ask = sanitizeAsk(r);
      return ask ? { ...base, type: "ask", ...ask } : null;
    }
    case "file": {
      const name = str(r.name, 160);
      if (!name) return null;
      const mime = str(r.mime, 80) || "application/octet-stream";
      const bytes = typeof r.bytes === "number" && Number.isFinite(r.bytes) && r.bytes >= 0 ? Math.round(r.bytes) : undefined;
      const image = str(r.image, 1500); const link = str(r.link, 500); const assetId = str(r.assetId, 40);
      const folder = r.folder === "creas" || r.folder === "briefs" ? r.folder : undefined;
      return { ...base, type: "file", name, mime, ...(bytes !== undefined ? { bytes } : {}), ...(cardImageOk(image) ? { image } : {}), ...(/^https:\/\//.test(link) ? { link } : {}), ...(/^[\w-]+$/.test(assetId) ? { assetId } : {}), ...(folder ? { folder } : {}) };
    }
    case "action": {
      const a = sanitizePublishAction(r);
      return a ? { ...base, type: "action", ...a } : null;
    }
    // A frame is laid by the application (lib/mo/frames.ts), never by the model.
    default:
      return null;
  }
}

/** « action » of kind publish: the prepared Pilotage draft and its editable texts; null when the essentials are missing. */
export function sanitizePublishAction(raw: unknown): MoPublishAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "publish") return null;
  const actionId = str(r.actionId, 40); const assetId = str(r.assetId, 40); const adsetId = str(r.adsetId, 30);
  if (!/^[\w-]+$/.test(actionId) || !/^[\w-]+$/.test(assetId) || !/^\d{5,25}$/.test(adsetId)) return null;
  const status = r.status === "sent" || r.status === "failed" ? r.status : "to_confirm" as const;
  const image = str(r.image, 1500); const pageId = str(r.pageId, 30); const headline = str(r.headline, 255); const cta = str(r.cta, 40); const textsFrom = str(r.textsFrom, 160); const adId = str(r.adId, 40); const error = str(r.error, 400);
  const pilotage = sanitizeOpen(r.pilotage) ?? "/pilotage";
  return {
    kind: "publish", actionId, status, assetId, ...(cardImageOk(image) ? { image } : {}),
    account: str(r.account, 120), adset: str(r.adset, 160), adsetId, page: str(r.page, 120), ...(/^\d{5,25}$/.test(pageId) ? { pageId } : {}),
    name: str(r.name, 255), primaryText: str(r.primaryText, 2000), ...(headline ? { headline } : {}), linkUrl: str(r.linkUrl, 2000), ...(cta ? { cta } : {}), ...(textsFrom ? { textsFrom } : {}),
    writesOpen: r.writesOpen === true, hq: str(r.hq, 300), ...(/^\d+$/.test(adId) ? { adId } : {}), ...(error ? { error } : {}), pilotage,
  };
}

/** « ask »: a question (≤ 200 chars) and 1-4 distinct options of ≤ 60 chars; null when unusable. */
export function sanitizeAsk(raw: unknown): MoAsk | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const question = str(r.question, MAX_ASK_QUESTION);
  if (!question) return null;
  const options: string[] = [];
  for (const o of Array.isArray(r.options) ? r.options : []) {
    const v = str(o, MAX_ASK_OPTION);
    if (v && !options.includes(v)) options.push(v);
    if (options.length >= MAX_ASK_OPTIONS) break;
  }
  return options.length ? { question, options } : null;
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
    const ask = sanitizeAsk(o.ask);
    const rawSay = str(o.say, MAX_SAY);
    // A question: what is said is the question (after the model's own words when they do not already carry it).
    const say = ask ? (rawSay && !rawSay.includes(ask.question) ? `${rawSay} ${ask.question}`.slice(0, MAX_SAY) : ask.question)
      : rawSay || (cards.length ? `Voilà, ${cards.length === 1 ? "la carte est" : "les cartes sont"} à l'écran.` : updates.length ? "C'est mis à jour à l'écran." : open ? "J'ouvre la page." : "Je n'ai rien trouvé à afficher.");
    return { say, cards, updates, remove, ...(open ? { open } : {}), ...(ask ? { ask } : {}) };
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
    const base = { id: c.id, x: c.x, y: c.y, w: c.w, ...(c.h ? { h: c.h } : {}), ...(c.z !== undefined ? { z: c.z } : {}), ...(c.ref ? { ref: c.ref } : {}), ...(c.clientId ? { clientId: c.clientId } : {}), ...(c.clientName ? { clientName: c.clientName } : {}), ...(c.frame ? { frame: c.frame } : {}), ...(c.link ? { link: c.link, ...(c.linkLabel ? { linkLabel: c.linkLabel } : {}) } : {}), minimized: false, turn, at, title: title ?? c.title, ...(subtitle ? { subtitle } : c.subtitle ? { subtitle: c.subtitle } : {}) };
    if ("type" in rest && rest.type) {
      // New content: same size unless the type changed (then the default size of the new type).
      const size = rest.type === c.type ? { w: c.w, h: c.h } : CARD_SIZES[rest.type];
      out.push({ ...base, ...rest, w: size.w, ...(size.h ? { h: size.h } : {}) } as MoCard);
    } else {
      const { x: _x, y: _y, w: _w, h: _h, z: _z, ref: _r, minimized: _m, turn: _t, at: _a, title: _ti, subtitle: _su, id: _i, clientId: _ci, clientName: _cn, frame: _f, link: _l, linkLabel: _ll, ...payload } = c; void [_x, _y, _w, _h, _z, _r, _m, _t, _a, _ti, _su, _i, _ci, _cn, _f, _l, _ll];
      out.push({ ...base, ...payload } as MoCard);
    }
  }
  return { cards: out, touched };
}

/**
 * Places the cards of one turn on new rows under everything already on the
 * board (rows wrap at ROW_WRAP_WIDTH), on top of the stack — the free cards.
 * Cards that belong to a client go in its frame: see `layoutWithFrames`
 * (lib/mo/frames.ts), which calls this for the rest.
 */
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
  const visible = cards.filter((c) => c.type !== "frame").slice(-24);
  if (!visible.length) return "Aucune carte à l'écran pour l'instant.";
  const detail = (c: MoCard): string => {
    switch (c.type) {
      case "creatives": return ` — visuels : ${c.items.slice(0, 12).map((it) => `${it.name}${it.adId ? ` [ad ${it.adId}]` : it.assetId ? ` [asset ${it.assetId}]` : ""}`).join(" ; ")}${c.items.length > 12 ? ` ; +${c.items.length - 12}` : ""}`;
      case "table": return ` — colonnes : ${c.columns.join(", ")} (${c.rows.length} lignes)`;
      case "kpis": return ` — ${c.items.map((k) => `${k.label} ${k.value}`).join(", ")}`;
      case "chart": return ` — ${c.series.map((s) => s.name).join(", ")} sur ${c.x.length} points`;
      case "note": return "";
      case "ask": return ` — question : ${c.question} (${c.options.join(" / ")})`;
      case "file": return ` — fichier ${c.name}${c.assetId ? ` [asset ${c.assetId}]` : ""}${c.link ? " (dans le Drive)" : ""}`;
      case "action": return ` — publication ${c.status === "sent" ? "envoyée (PAUSED)" : c.status === "failed" ? "en échec" : "à confirmer par la personne"} : ${c.adset} [asset ${c.assetId}]`;
      case "frame": return " — cadre client";
    }
  };
  const verdicts = (c: MoCard) => (c.type === "creatives" ? c.items.filter((it) => it.verdict).map((it) => `${it.name} ${it.verdict === "keep" ? "gardée" : "coupée"}`) : []);
  return visible.map((c) => `- ${c.id} · ${c.type} · « ${c.title} »${c.subtitle ? ` (${c.subtitle})` : ""}${c.clientName ? ` [client ${c.clientName}]` : ""}${detail(c)}${verdicts(c).length ? ` — verdicts : ${verdicts(c).join(" ; ")}` : ""}${c.type !== "file" && c.link ? ` — exportée (${c.linkLabel ?? "lien"})` : ""}`).join("\n");
}

export function boardTitleFrom(messages: MoMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.content.replace(/\s+/g, " ").trim() ?? "";
  return first.length > 60 ? first.slice(0, 59).trimEnd() + "…" : first || "Session Mo";
}
