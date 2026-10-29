/**
 * Mo's deterministic actions (POST /api/mo/[id]/act): what the consultant
 * does on a card without the model — a verdict on a visual, the figures under
 * the visuals, an editor, the Drive, the Ad Library, a publication prepared
 * then confirmed, a file dropped on the board, a card exported as a Google
 * Sheet. Each one is journaled on the board as a « action » line (never shown
 * to the model).
 *
 * The pure parts (reading the request, finding the card's client, the verdict
 * on an item, the publish card) are at the top; `runMoAct` ties them to the
 * existing server code through `ActDeps` (lib/mo/tools.ts, lib/studio-assets.ts,
 * lib/creas/open-editor.ts, lib/clients/drive.ts) so the business rules live
 * in one place and the flows can be tested with fakes.
 */

import { CARD_SIZES, COL_GAP, type MoActionKind, type MoCard, type MoCardSpec, type MoCreative, type MoVerdict } from "@/lib/mo/model";
import { isClientId, matchClientName, type IntentClient } from "@/lib/mo/intents";
import { typeKpiSheet, typeSheetColumns, type SheetCell } from "@/lib/sheet-values";

// ── Requests ────────────────────────────────────────────────────────────────

export type ActEditor = "figcraft" | "photocraft";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type ActRequest =
  | { action: "verdict"; cardId: string; item: number; verdict: MoVerdict | null; said?: string }
  | { action: "creative_metrics"; cardId: string; period?: string; said?: string }
  | { action: "open_editor"; cardId: string; item: number; editor: ActEditor }
  | { action: "drive"; cardId: string; item: number }
  | { action: "competitor_ads"; query: string; clientId?: string; said?: string }
  | { action: "publish_prepare"; cardId: string; item: number; adsetId?: string; pageId?: string; primaryText?: string; headline?: string; linkUrl?: string; cta?: string; said?: string }
  | { action: "publish_confirm"; cardId: string; primaryText?: string; headline?: string; linkUrl?: string }
  | { action: "upload"; name: string; mime: string; bytes: number; data: string; clientId?: string; x: number; y: number }
  /** « Exporter en Google Sheet » : the rows of a table / KPI / creatives card become a Sheet in the Drive, its link lands on the card. */
  | { action: "sheet"; cardId: string; said?: string };

const CARD_ID_RE = /^[a-z0-9]{3,24}$/i;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const idx = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 64 ? v : null);

/** The request as the browser sent it, checked field by field; an error message when unusable. */
export function parseActRequest(body: unknown): ActRequest | { error: string } {
  if (!body || typeof body !== "object") return { error: "Demande illisible." };
  const b = body as Record<string, unknown>;
  const cardId = str(b.cardId, 24);
  const said = str(b.said, 400) || undefined;
  const needCard = () => (CARD_ID_RE.test(cardId) ? null : { error: "Carte inconnue." });
  switch (b.action) {
    case "verdict": {
      const bad = needCard(); if (bad) return bad;
      const item = idx(b.item); if (item === null) return { error: "Quel visuel ?" };
      const verdict = b.verdict === "keep" || b.verdict === "cut" ? b.verdict : b.verdict === null ? null : undefined;
      if (verdict === undefined) return { error: "Verdict inconnu (garder ou couper)." };
      return { action: "verdict", cardId, item, verdict, ...(said ? { said } : {}) };
    }
    case "creative_metrics": {
      const bad = needCard(); if (bad) return bad;
      const period = str(b.period, 20) || undefined;
      return { action: "creative_metrics", cardId, ...(period ? { period } : {}), ...(said ? { said } : {}) };
    }
    case "open_editor": {
      const bad = needCard(); if (bad) return bad;
      const item = idx(b.item); if (item === null) return { error: "Quel visuel ?" };
      if (b.editor !== "figcraft" && b.editor !== "photocraft") return { error: "Éditeur inconnu." };
      return { action: "open_editor", cardId, item, editor: b.editor };
    }
    case "drive": {
      const bad = needCard(); if (bad) return bad;
      const item = idx(b.item); if (item === null) return { error: "Quel visuel ?" };
      return { action: "drive", cardId, item };
    }
    case "competitor_ads": {
      const query = str(b.query, 100);
      if (query.length < 2) return { error: "Quelle marque ?" };
      const clientId = str(b.clientId, 40);
      return { action: "competitor_ads", query, ...(CLIENT_ID_RE.test(clientId) ? { clientId } : {}), ...(said ? { said } : {}) };
    }
    case "publish_prepare": {
      const bad = needCard(); if (bad) return bad;
      const item = idx(b.item); if (item === null) return { error: "Quel visuel ?" };
      const adsetId = str(b.adsetId, 30); const pageId = str(b.pageId, 30);
      const primaryText = str(b.primaryText, 2000); const headline = str(b.headline, 255); const linkUrl = str(b.linkUrl, 2000); const cta = str(b.cta, 40);
      return { action: "publish_prepare", cardId, item, ...(/^\d{5,25}$/.test(adsetId) ? { adsetId } : {}), ...(/^\d{5,25}$/.test(pageId) ? { pageId } : {}), ...(primaryText ? { primaryText } : {}), ...(headline ? { headline } : {}), ...(linkUrl ? { linkUrl } : {}), ...(cta ? { cta } : {}), ...(said ? { said } : {}) };
    }
    case "publish_confirm": {
      const bad = needCard(); if (bad) return bad;
      const primaryText = str(b.primaryText, 2000); const headline = str(b.headline, 255); const linkUrl = str(b.linkUrl, 2000);
      return { action: "publish_confirm", cardId, ...(primaryText ? { primaryText } : {}), ...(headline ? { headline } : {}), ...(linkUrl ? { linkUrl } : {}) };
    }
    case "sheet": {
      const bad = needCard(); if (bad) return bad;
      return { action: "sheet", cardId, ...(said ? { said } : {}) };
    }
    case "upload": {
      const name = str(b.name, 160) || "fichier";
      const mime = str(b.mime, 80).toLowerCase();
      const data = typeof b.data === "string" ? b.data : "";
      const bytes = typeof b.bytes === "number" && Number.isFinite(b.bytes) ? Math.round(b.bytes) : Math.round(data.length * 0.75);
      if (!data) return { error: "Fichier vide." };
      if (bytes > MAX_UPLOAD_BYTES) return { error: "Fichier trop lourd (20 Mo au plus)." };
      if (!fileKindOf(mime, name)) return { error: "Format non pris en charge : PNG, JPG, WebP (visuel) ou PDF, DOCX (brief)." };
      const clientId = str(b.clientId, 40);
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      return { action: "upload", name, mime, bytes, data, ...(CLIENT_ID_RE.test(clientId) ? { clientId } : {}), x: num(b.x), y: num(b.y) };
    }
    default:
      return { error: "Action inconnue." };
  }
}

/** A dropped file: a visual (kept as an asset, Drive « Créas ») or a brief (Drive « Briefs »); null when neither. */
export function fileKindOf(mime: string, name: string): "image" | "brief" | null {
  const m = mime.toLowerCase(); const n = name.toLowerCase();
  if (/^image\/(png|jpe?g|webp)$/.test(m) || /\.(png|jpe?g|webp)$/.test(n)) return "image";
  if (m === "application/pdf" || /\.pdf$/.test(n)) return "brief";
  if (/wordprocessingml|msword/.test(m) || /\.docx?$/.test(n)) return "brief";
  return null;
}

export const briefMime = (mime: string, name: string): string => {
  if (/^application\/(pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/.test(mime)) return mime;
  return /\.pdf$/i.test(name) ? "application/pdf" : /\.docx$/i.test(name) ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/msword";
};

// ── Cards ───────────────────────────────────────────────────────────────────

/** The client a card is about: its `clientId` when a tool set it, else the client named in its title / subtitle. */
export function cardClientOf<C extends IntentClient>(card: Pick<MoCard, "clientId" | "title" | "subtitle"> | null | undefined, clients: C[]): C | null {
  if (!card) return null;
  if (card.clientId) { const c = clients.find((x) => isClientId(x, card.clientId)); if (c) return c; }
  return matchClientName(`${card.title} ${card.subtitle ?? ""}`, clients) as C | null;
}

/** The topmost card under a world point (a drop), or null. */
export function hitTestCard(cards: MoCard[], pt: { x: number; y: number }): MoCard | null {
  let best: MoCard | null = null;
  for (const c of cards) {
    const h = c.minimized ? 44 : c.h ?? CARD_SIZES[c.type].h;
    if (pt.x >= c.x && pt.x <= c.x + c.w && pt.y >= c.y && pt.y <= c.y + h && (!best || (c.z ?? 0) >= (best.z ?? 0))) best = c;
  }
  return best;
}

/** The client a dropped file goes to: the card under the drop, else the most recent card that names a client. */
export function dropClientOf<C extends IntentClient>(cards: MoCard[], pt: { x: number; y: number }, clients: C[]): C | null {
  const under = cardClientOf(hitTestCard(cards, pt), clients);
  if (under) return under;
  for (const c of [...cards].sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0))) { const k = cardClientOf(c, clients); if (k) return k; }
  return null;
}

/** The period a creatives card covers (« … · 2026-10-26 → 2026-10-28 »), or null. */
export function cardPeriodOf(card: Pick<MoCard, "subtitle">): { since: string; until: string } | null {
  const m = card.subtitle?.match(/(\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2})/);
  return m ? { since: m[1], until: m[2] } : null;
}

/** The card with the verdict written on one visual (same verdict again = undone); extra fields (templateId, link) kept. */
export function withItemPatch(card: MoCard, index: number, patch: Omit<Partial<MoCreative>, "verdict"> & { verdict?: MoVerdict | null }): MoCard {
  if (card.type !== "creatives") return card;
  const items = card.items.map((it, i) => {
    if (i !== index) return it;
    const { verdict, ...rest } = patch;
    const next: MoCreative = { ...it, ...rest };
    if (verdict === null) delete next.verdict; else if (verdict) next.verdict = verdict;
    return next;
  });
  return { ...card, items, at: new Date().toISOString() };
}

/** The platform and bare id of a warehouse ad on a card (« /api/mo/ad-image/meta/123 » says the platform). */
export function warehouseAdOf(item: Pick<MoCreative, "adId" | "image">): { platform: string; adId: string } | null {
  if (!item.adId || item.adId.startsWith("adlib:")) return null;
  const pref = item.adId.match(/^(meta|google|tiktok|linkedin):(.+)$/);
  if (pref) return { platform: pref[1], adId: pref[2] };
  const img = item.image?.match(/^\/api\/mo\/ad-image\/(meta|google|tiktok|linkedin)\//);
  return { platform: img?.[1] ?? "meta", adId: item.adId };
}

/** What `meta_publish_ad` (phase 1) returns, as the card needs it. */
export interface PreparedPublish {
  actionId: string; writes_open?: boolean; hq?: string; texts_from?: string;
  summary: { account: string; adset: string; adsetId?: string; page: string; pageId?: string; name: string; primaryText: string; headline: string | null; link: string; cta: string; image?: string };
}

/** The « À publier » card from a prepared publication (status to_confirm). */
export function publishCardSpec(prepared: PreparedPublish, src: { clientId: string; clientName: string; assetId: string; adsetId: string; ref?: string; pilotage: string }): MoCardSpec {
  const s = prepared.summary;
  return {
    type: "action", kind: "publish", title: `À publier — ${src.clientName}`, subtitle: `Meta · ${s.account} · en pause à la création`, clientId: src.clientId, clientName: src.clientName, ...(src.ref ? { ref: src.ref } : {}),
    actionId: prepared.actionId, status: "to_confirm", assetId: src.assetId, ...(s.image ? { image: s.image } : {}),
    account: s.account, adset: s.adset, adsetId: s.adsetId ?? src.adsetId, page: s.page, ...(s.pageId ? { pageId: s.pageId } : {}),
    name: s.name, primaryText: s.primaryText, ...(s.headline ? { headline: s.headline } : {}), linkUrl: s.link, ...(s.cta && !s.cta.startsWith("(") ? { cta: s.cta } : {}),
    ...(prepared.texts_from ? { textsFrom: prepared.texts_from } : {}),
    writesOpen: prepared.writes_open === true, hq: prepared.hq ?? "", pilotage: src.pilotage,
  };
}

/** Where a publication card goes: right of its visual's card. */
export const besideCard = (card: Pick<MoCard, "x" | "y" | "w">) => ({ x: card.x + card.w + COL_GAP, y: card.y });

// ── Export as a Google Sheet ────────────────────────────────────────────────

/** The card types whose content is rows. */
export const SHEET_CARD_TYPES = ["table", "kpis", "creatives"] as const;
export type SheetCard = Extract<MoCard, { type: (typeof SHEET_CARD_TYPES)[number] }>;
export const isSheetCard = (card: Pick<MoCard, "type"> | null | undefined): card is SheetCard => !!card && (SHEET_CARD_TYPES as readonly string[]).includes(card.type);

/** The Drive folder of the tables that belong to no client, under the agency root. */
export const MO_TABLES_ROOT_FOLDER = { name: "Mo – Tableaux", description: "Tableaux exportés depuis Mo en Google Sheets quand aucun client n'est concerné. Dossier ImpulseMotion." } as const;

/**
 * The rows of a card as a sheet: a table as it is; the KPIs one per line
 * (indicateur, valeur, variation); the creatives one per visual (name, id,
 * the union of their metrics in order of first appearance, the verdict when
 * one was given). Null for a card without rows (chart, note…).
 */
export function sheetRowsOf(card: MoCard): { columns: string[]; rows: string[][] } | null {
  switch (card.type) {
    case "table":
      return { columns: card.columns, rows: card.rows.map((r) => card.columns.map((_, j) => r[j] ?? "")) };
    case "kpis":
      return { columns: ["Indicateur", "Valeur", "Variation"], rows: card.items.map((k) => [k.label, k.value, k.delta ?? ""]) };
    case "creatives": {
      const metrics: string[] = [];
      for (const it of card.items) for (const k of Object.keys(it.metrics)) if (!metrics.includes(k)) metrics.push(k);
      const verdicts = card.items.some((it) => it.verdict);
      const columns = ["Visuel", "Identifiant", ...metrics, ...(verdicts ? ["Verdict"] : [])];
      const rows = card.items.map((it) => [it.name, it.adId ?? it.assetId ?? "", ...metrics.map((k) => it.metrics[k] ?? ""), ...(verdicts ? [it.verdict === "keep" ? "Gardée" : it.verdict === "cut" ? "Coupée" : ""] : [])]);
      return { columns, rows };
    }
    default:
      return null;
  }
}

/**
 * The rows of a card as the sheet receives them: numbers as numbers with the
 * unit in the header (« Dépense (€) »), the KPIs' unit in their label
 * (« CPA (€) »), text and mixed columns as shown, dashes as empty cells.
 */
export function sheetValuesOf(card: MoCard): { columns: string[]; rows: SheetCell[][] } | null {
  const data = sheetRowsOf(card);
  if (!data) return null;
  return card.type === "kpis" ? typeKpiSheet(data.rows) : typeSheetColumns(data.columns, data.rows);
}

/** « Chiffres Naturalia — 29 oct. 2026 » : the sheet's name from the card's title and a date. */
export function sheetFileName(title: string, at: Date = new Date()): string {
  const clean = title.replace(/[\u0000-\u001f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Tableau Mo";
  return `${clean} — ${at.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}`;
}

const shortLabel = (s: string, max = 60) => (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s);

// ── Running an action ───────────────────────────────────────────────────────

type ToolResult = Record<string, unknown>;

export interface ActClient extends IntentClient { clientId: string; dashboardId: string | null; hqSlug?: string | null }

export interface ActDeps {
  loadCards(): Promise<MoCard[]>;
  rewriteCard(cardId: string, fn: (card: MoCard) => MoCard | null): Promise<MoCard | null>;
  placeCard(spec: MoCardSpec, at: { x: number; y: number }): Promise<MoCard | null>;
  journal(action: { kind: MoActionKind; clientId?: string; cardIds: string[]; label: string }, content?: string): Promise<void>;
  clients(): Promise<ActClient[]>;
  /** lib/studio-assets setAssetFeedback */
  assetFeedback(assetId: string, verdict: MoVerdict | null): Promise<{ ok: true; hq: { ok: boolean; error?: string } } | { ok: false; status: number; error: string }>;
  /** lib/mo/tools (same signatures as the MCP tools) */
  keepTemplate(args: ToolResult): Promise<ToolResult>;
  creativeMetrics(args: ToolResult): Promise<ToolResult>;
  metaTargets(args: ToolResult): Promise<ToolResult>;
  metaPublishAd(args: ToolResult): Promise<ToolResult>;
  competitorAds(args: ToolResult): Promise<ToolResult>;
  /** lib/creas/open-editor */
  openEditor(input: { editor: ActEditor; assetId?: string; templateId?: string; clientId?: string }): Promise<{ ok: true; path: string } | { ok: false; status: number; error: string }>;
  /** lib/studio-assets createBrandAsset (a dropped visual) */
  createAsset(input: { clientId: string; image: string; name: string }): Promise<{ ok: true; assetId: string } | { ok: false; status: number; error: string }>;
  /** Bytes of a visual to copy into the Drive. */
  assetBytes(assetId: string): Promise<{ buf: Buffer; mimeType: string } | null>;
  adImageBytes(platform: string, adId: string): Promise<{ buf: Buffer; mimeType: string } | null>;
  /** lib/clients/drive */
  driveUpload(dashboardId: string, folder: "creas" | "briefs", file: { name: string; mimeType: string; data: Buffer }): Promise<{ link: string | null }>;
  /** The folder a sheet goes to: the client's « Tableaux » (ensureClientSubfolder) when a dashboard is given, else « Mo – Tableaux » under the root (ensureRootSubfolder); null when the client's folder cannot be made. */
  sheetFolder(dashboardId: string | null): Promise<{ id: string } | null>;
  /** lib/clients/drive createSheetFromRows */
  createSheet(folderId: string, name: string, columns: string[], rows: SheetCell[][]): Promise<{ id: string; webViewLink: string | null }>;
}

export interface ActResult {
  say: string;
  cardIds: string[];
  card?: MoCard;
  /** The page to open (an editor). */
  open?: string;
  /** Publication: the person must pick the ad set first. */
  needs?: { adset: Array<{ adsetId: string; adset: string; campaign: string; spend_30d: number; status: string | null }> };
  hq?: { ok: boolean; error?: string };
}

export class ActError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

const toolErrorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const asPrepared = (r: ToolResult): PreparedPublish => r as unknown as PreparedPublish;

const creativesCard = (card: MoCard | undefined, index: number): { card: Extract<MoCard, { type: "creatives" }>; item: MoCreative } => {
  if (!card || card.type !== "creatives") throw new ActError("Cette action vaut pour un visuel d'une carte créas.", 404);
  const item = card.items[index];
  if (!item) throw new ActError("Ce visuel n'est plus sur la carte.", 404);
  return { card, item };
};

/** Runs one action for the caller; throws ActError (message for the person, HTTP status). */
export async function runMoAct(req: ActRequest, deps: ActDeps, who: string): Promise<ActResult> {
  const cards = await deps.loadCards();
  const clients = await deps.clients();
  const find = (id: string) => cards.find((c) => c.id === id);

  switch (req.action) {
    case "verdict": {
      const { card, item } = creativesCard(find(req.cardId), req.item);
      const client = cardClientOf(card, clients);
      const next: MoVerdict | null = req.verdict !== null && item.verdict === req.verdict ? null : req.verdict;
      let hq: { ok: boolean; error?: string } | undefined;
      let templateId = item.templateId;
      const notes: string[] = [];
      if (item.assetId) {
        const r = await deps.assetFeedback(item.assetId, next);
        if (!r.ok) throw new ActError(r.error, r.status);
        hq = r.hq;
        if (next) notes.push(r.hq.ok ? "consignée dans HQ" : r.hq.error ? `HQ : ${r.hq.error}` : "");
        if (next) notes.push("visible dans Créas");
      } else if (next === "keep" && item.adId && !templateId) {
        // A warehouse ad kept = a template « own » of the client; a competitor ad kept = a template « competitor ».
        const own = warehouseAdOf(item);
        try {
          const r = own
            ? await deps.keepTemplate({ adId: `${own.platform}:${own.adId}`, ...(client ? { client: client.id } : {}), analyse: false })
            : await deps.keepTemplate({ libraryId: item.adId, ...(item.image && /^https:\/\//.test(item.image) ? { imageUrl: item.image } : {}), brand: item.name.split(" · ")[0], ...(item.note ? { body: item.note } : {}), ...(client ? { client: client.id } : {}), analyse: false });
          templateId = typeof r.templateId === "string" ? r.templateId : templateId;
          notes.push("template enregistré dans Créas");
        } catch (e) { notes.push(`template non enregistré : ${toolErrorMessage(e)}`); }
      }
      const updated = await deps.rewriteCard(card.id, (c) => withItemPatch(c, req.item, { verdict: next, ...(templateId ? { templateId } : {}) }));
      const label = next === "keep" ? `Gardée : ${shortLabel(item.name)}` : next === "cut" ? `Coupée : ${shortLabel(item.name)}` : `Verdict retiré : ${shortLabel(item.name)}`;
      await deps.journal({ kind: "verdict", ...(client ? { clientId: client.id } : {}), cardIds: [card.id], label: `${label}${client ? ` (${client.name})` : ""}` }, req.said);
      const said = next === "keep" ? "Gardée." : next === "cut" ? "Coupée." : "Verdict retiré.";
      const extra = notes.filter(Boolean);
      return { say: extra.length ? `${said.replace(/\.$/, "")}, ${extra.join(", ")}.` : said, cardIds: [card.id], ...(updated ? { card: updated } : {}), ...(hq ? { hq } : {}) };
    }

    case "creative_metrics": {
      const card = find(req.cardId);
      if (!card || card.type !== "creatives") throw new ActError("Il me faut une carte créas pour mettre les chiffres dessous.", 404);
      const ads = card.items.map(warehouseAdOf).filter((x): x is { platform: string; adId: string } => !!x);
      if (!ads.length) throw new ActError("Ces visuels ne sont pas des annonces diffusées : pas de chiffres à mettre dessous.", 400);
      const client = cardClientOf(card, clients);
      if (!client) throw new ActError("Je ne sais pas de quel client sont ces créas.", 400);
      const period = cardPeriodOf(card);
      const args: ToolResult = { client: client.id, adIds: ads.map((a) => a.adId), ...(req.period ? { period: req.period } : period ? { since: period.since, until: period.until } : { period: "last_7d" }) };
      let r: ToolResult;
      try { r = await deps.creativeMetrics(args); } catch (e) { throw new ActError(`Je n'ai pas pu : ${toolErrorMessage(e)}`, 502); }
      const touched = Array.isArray(r.updated_cards) ? (r.updated_cards as string[]) : [];
      const found = Array.isArray(r.items) ? (r.items as Array<{ found?: boolean }>).filter((it) => it.found).length : 0;
      await deps.journal({ kind: "creative_metrics", clientId: client.id, cardIds: touched.length ? touched : [card.id], label: `Chiffres sous ${found} visuel${found > 1 ? "s" : ""} (${client.name})` }, req.said);
      return { say: found ? `Les chiffres sont sous ${found === card.items.length ? "chaque visuel" : `${found} visuel${found > 1 ? "s" : ""}`}.` : "Aucun chiffre sur la période pour ces visuels.", cardIds: touched };
    }

    case "open_editor": {
      const { card, item } = creativesCard(find(req.cardId), req.item);
      const client = cardClientOf(card, clients);
      let source: { assetId?: string; templateId?: string } = {};
      if (item.assetId) source = { assetId: item.assetId };
      else if (item.templateId) source = { templateId: item.templateId };
      else if (item.adId) {
        // A platform ad opens as a template of the client (kept first, so the editor's brief knows it).
        const own = warehouseAdOf(item);
        let r: ToolResult;
        try {
          r = own
            ? await deps.keepTemplate({ adId: `${own.platform}:${own.adId}`, ...(client ? { client: client.id } : {}), analyse: false })
            : await deps.keepTemplate({ libraryId: item.adId, ...(item.image && /^https:\/\//.test(item.image) ? { imageUrl: item.image } : {}), brand: item.name.split(" · ")[0], ...(item.note ? { body: item.note } : {}), ...(client ? { client: client.id } : {}), analyse: false });
        } catch (e) { throw new ActError(`Je n'ai pas pu préparer le visuel : ${toolErrorMessage(e)}`, 502); }
        if (typeof r.templateId !== "string") throw new ActError("Le visuel n'a pas pu être préparé pour l'éditeur.", 502);
        source = { templateId: r.templateId };
        await deps.rewriteCard(card.id, (c) => withItemPatch(c, req.item, { templateId: r.templateId as string }));
      } else throw new ActError("Ce visuel n'a ni fichier ni annonce à ouvrir.", 400);
      const opened = await deps.openEditor({ editor: req.editor, ...source, ...(client ? { clientId: client.clientId } : {}) });
      if (!opened.ok) throw new ActError(opened.error, opened.status);
      const editor = req.editor === "figcraft" ? "FigCraft" : "PhotoCraft";
      await deps.journal({ kind: "open_editor", ...(client ? { clientId: client.id } : {}), cardIds: [card.id], label: `${shortLabel(item.name)} ouvert dans ${editor}${client ? ` (${client.name})` : ""}` });
      return { say: `J'ouvre ${editor}.`, cardIds: [card.id], open: opened.path };
    }

    case "drive": {
      const { card, item } = creativesCard(find(req.cardId), req.item);
      const client = cardClientOf(card, clients);
      if (!client) throw new ActError("Je ne sais pas dans le Drive de quel client le ranger.", 400);
      if (!client.dashboardId) throw new ActError(`${client.name} n'a pas de dossier Drive (client sans dashboard).`, 400);
      if (item.link && /drive\.google\.com/.test(item.link)) return { say: "Ce visuel est déjà dans le Drive.", cardIds: [card.id], card };
      const own = warehouseAdOf(item);
      const bytes = item.assetId ? await deps.assetBytes(item.assetId) : own ? await deps.adImageBytes(own.platform, own.adId) : null;
      if (!bytes) throw new ActError("Je n'ai pas l'image de ce visuel à envoyer.", 404);
      const ext = bytes.mimeType.includes("jpeg") ? "jpg" : bytes.mimeType.includes("webp") ? "webp" : "png";
      const base = item.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "visuel";
      let link: string | null;
      try { link = (await deps.driveUpload(client.dashboardId, "creas", { name: `${base}-${(item.assetId ?? own?.adId ?? "x").slice(-6)}.${ext}`, mimeType: bytes.mimeType, data: bytes.buf })).link; }
      catch (e) { throw new ActError(`Le Drive n'a pas répondu : ${toolErrorMessage(e)}`, 502); }
      const updated = await deps.rewriteCard(card.id, (c) => withItemPatch(c, req.item, link ? { link } : {}));
      await deps.journal({ kind: "drive", clientId: client.id, cardIds: [card.id], label: `${shortLabel(item.name)} rangé dans le Drive « Créas » (${client.name})` });
      return { say: "C'est dans le Drive du client, dossier Créas.", cardIds: [card.id], ...(updated ? { card: updated } : {}) };
    }

    case "competitor_ads": {
      const client = req.clientId ? clients.find((c) => c.id === req.clientId) ?? null : null;
      let r: ToolResult;
      try { r = await deps.competitorAds({ query: req.query }); } catch (e) { throw new ActError(`Je n'ai pas pu : ${toolErrorMessage(e)}`, 502); }
      const posted = typeof r.posted_card === "string" ? r.posted_card : null;
      const count = typeof r.count === "number" ? r.count : 0;
      if (posted && client) await deps.rewriteCard(posted, (c) => ({ ...c, clientId: client.id, clientName: client.name }) as MoCard);
      await deps.journal({ kind: "competitor_ads", ...(client ? { clientId: client.id } : {}), cardIds: posted ? [posted] : [], label: `${count} pub${count > 1 ? "s" : ""} de ${req.query} (bibliothèque Meta)` }, req.said);
      return { say: count ? `Voilà ${count} pub${count > 1 ? "s" : ""} de ${req.query} en ce moment.` : `Je ne trouve aucune pub active pour ${req.query}.`, cardIds: posted ? [posted] : [] };
    }

    case "publish_prepare": {
      const { card, item } = creativesCard(find(req.cardId), req.item);
      if (!item.assetId) throw new ActError("Publier vaut pour un visuel généré ou déposé (pas une annonce déjà diffusée).", 400);
      const client = cardClientOf(card, clients);
      if (!client) throw new ActError("Je ne sais pas pour quel client publier ce visuel.", 400);
      let adsetId = req.adsetId;
      if (!adsetId) {
        let t: ToolResult;
        try { t = await deps.metaTargets({ client: client.id }); } catch (e) { throw new ActError(`Je n'ai pas pu lire les ensembles : ${toolErrorMessage(e)}`, 502); }
        const targets = (Array.isArray(t.targets) ? t.targets : []) as Array<{ adsetId: string | null; adset: string | null; campaign: string | null; spend_30d: number; status: string | null }>;
        const live = targets.filter((x) => x.adsetId && /^\d{5,25}$/.test(x.adsetId));
        if (!live.length) throw new ActError(`Aucun ensemble de publicités connu pour ${client.name} : rien à publier dedans.`, 404);
        if (live.length > 1) return { say: "Dans quel ensemble ?", cardIds: [card.id], needs: { adset: live.slice(0, 8).map((x) => ({ adsetId: x.adsetId!, adset: x.adset ?? x.adsetId!, campaign: x.campaign ?? "", spend_30d: x.spend_30d, status: x.status })) } };
        adsetId = live[0].adsetId!;
      }
      let r: ToolResult;
      try {
        r = await deps.metaPublishAd({ client: client.id, assetId: item.assetId, adsetId, ...(req.pageId ? { pageId: req.pageId } : {}), ...(req.primaryText ? { primaryText: req.primaryText } : {}), ...(req.headline ? { headline: req.headline } : {}), ...(req.linkUrl ? { linkUrl: req.linkUrl } : {}), ...(req.cta ? { callToAction: req.cta } : {}), why: `Créa « ${item.name.slice(0, 60)} » publiée depuis Mo par ${who}` });
      } catch (e) { throw new ActError(`Je n'ai pas pu préparer la publication : ${toolErrorMessage(e)}`, 502); }
      const prepared = asPrepared(r);
      if (!prepared.actionId || !prepared.summary) throw new ActError("La préparation n'a rien renvoyé d'utilisable.", 502);
      const spec = publishCardSpec(prepared, { clientId: client.id, clientName: client.name, assetId: item.assetId, adsetId, ref: card.id, pilotage: `/pilotage?dashboardId=${client.dashboardId ?? client.id}` });
      const placed = await deps.placeCard(spec, besideCard(card));
      if (!placed) throw new ActError("La carte n'a pas pu être posée.", 500);
      await deps.journal({ kind: "publish_prepare", clientId: client.id, cardIds: [placed.id], label: `Publication préparée : ${shortLabel(item.name)} → ${prepared.summary.adset} (${client.name})` }, req.said);
      return { say: `Publication préparée${prepared.texts_from ? `, textes repris de « ${prepared.texts_from} »` : ""} : relis et confirme.`, cardIds: [placed.id], card: placed };
    }

    case "publish_confirm": {
      const card = find(req.cardId);
      if (!card || card.type !== "action" || card.kind !== "publish") throw new ActError("Cette carte n'est pas une publication à confirmer.", 404);
      if (card.status === "sent") throw new ActError("Cette publication est déjà partie.", 409);
      const client = cardClientOf(card, clients);
      if (!client) throw new ActError("Client de la publication introuvable.", 400);
      let actionId = card.actionId;
      let texts = { primaryText: card.primaryText, headline: card.headline ?? "", linkUrl: card.linkUrl };
      const edited = (req.primaryText && req.primaryText !== card.primaryText) || (req.headline !== undefined && req.headline !== (card.headline ?? "")) || (req.linkUrl && req.linkUrl !== card.linkUrl);
      if (edited || card.status === "failed") {
        // Texts changed (or a failed send is retried): the draft is prepared again, then confirmed.
        texts = { primaryText: req.primaryText ?? card.primaryText, headline: req.headline ?? card.headline ?? "", linkUrl: req.linkUrl ?? card.linkUrl };
        let r: ToolResult;
        try { r = await deps.metaPublishAd({ client: client.id, assetId: card.assetId, adsetId: card.adsetId, ...(card.pageId ? { pageId: card.pageId } : {}), primaryText: texts.primaryText, ...(texts.headline ? { headline: texts.headline } : {}), linkUrl: texts.linkUrl, ...(card.cta ? { callToAction: card.cta } : {}), name: card.name, why: `Créa publiée depuis Mo par ${who}` }); }
        catch (e) { throw new ActError(`Je n'ai pas pu préparer à nouveau : ${toolErrorMessage(e)}`, 502); }
        const prepared = asPrepared(r);
        if (!prepared.actionId) throw new ActError("La préparation n'a rien renvoyé d'utilisable.", 502);
        actionId = prepared.actionId;
        await deps.rewriteCard(card.id, (c) => (c.type === "action" ? { ...c, actionId, primaryText: texts.primaryText, ...(texts.headline ? { headline: texts.headline } : {}), linkUrl: texts.linkUrl, status: "to_confirm" } as MoCard : c));
      }
      let outcome: { status?: string; adId?: string | null; error?: string | null; pilotage?: string };
      let failure: string | null = null;
      try { outcome = (await deps.metaPublishAd({ client: client.id, confirm: true, actionId, why: `Créa publiée depuis Mo par ${who}` })) as typeof outcome; }
      catch (e) { failure = toolErrorMessage(e); outcome = {}; }
      const adId = typeof outcome.adId === "string" && /^\d+$/.test(outcome.adId) ? outcome.adId : undefined;
      const sent = !failure && !!adId;
      const error = failure ?? (outcome.error ? String(outcome.error) : sent ? undefined : "La plateforme n'a pas renvoyé d'identifiant de publicité.");
      const updated = await deps.rewriteCard(card.id, (c) => (c.type === "action" ? { ...c, actionId, status: sent ? "sent" : "failed", ...(adId ? { adId } : {}), ...(error ? { error: error.slice(0, 400) } : {}), ...(error === undefined ? { error: undefined } : {}), title: sent ? `Publiée (en pause) — ${c.clientName ?? ""}`.replace(/ — $/, "") : c.title, at: new Date().toISOString() } as MoCard : c));
      await deps.journal({ kind: "publish_confirm", clientId: client.id, cardIds: [card.id], label: sent ? `Publicité créée EN PAUSE dans ${card.adset} (${client.name})` : `Publication en échec : ${(error ?? "").slice(0, 80)} (${client.name})` });
      if (!sent) throw new ActError(`La publication n'est pas partie : ${error}`, 502);
      return { say: "C'est publié, en pause : rien ne dépense avant l'activation dans le Gestionnaire.", cardIds: [card.id], ...(updated ? { card: updated } : {}) };
    }

    case "sheet": {
      const card = find(req.cardId);
      if (!card) throw new ActError("Cette carte n'est plus sur le tableau.", 404);
      if (!isSheetCard(card)) throw new ActError("Je n'exporte en Google Sheet que les tableaux, les KPI et les créas.", 400);
      const data = sheetValuesOf(card);
      if (!data || !data.columns.length) throw new ActError("Cette carte n'a pas de lignes à exporter.", 400);
      const client = cardClientOf(card, clients);
      let folder: { id: string } | null;
      try { folder = await deps.sheetFolder(client?.dashboardId ?? null); } catch (e) { throw new ActError(`Le Drive n'a pas répondu : ${toolErrorMessage(e)}`, 502); }
      if (!folder) throw new ActError("Je ne trouve pas de dossier Drive où poser la feuille.", 502);
      const name = sheetFileName(card.title);
      let sheet: { id: string; webViewLink: string | null };
      try { sheet = await deps.createSheet(folder.id, name, data.columns, data.rows); } catch (e) { throw new ActError(`Google Sheets n'a pas répondu : ${toolErrorMessage(e)}`, 502); }
      const link = sheet.webViewLink ?? `https://docs.google.com/spreadsheets/d/${sheet.id}/edit`;
      const updated = await deps.rewriteCard(card.id, (c) => ({ ...c, link, linkLabel: "Google Sheet", at: new Date().toISOString() }) as MoCard);
      await deps.journal({ kind: "sheet", ...(client ? { clientId: client.id } : {}), cardIds: [card.id], label: `Tableau « ${shortLabel(card.title)} » exporté dans Google Sheets${client ? ` (${client.name})` : ""}` }, req.said);
      return { say: "C'est dans Google Sheets, le lien est sur la carte.", cardIds: [card.id], ...(updated ? { card: updated } : {}) };
    }

    case "upload": {
      const client = req.clientId ? clients.find((c) => c.id === req.clientId || c.clientId === req.clientId) ?? null : dropClientOf(cards, { x: req.x, y: req.y }, clients);
      if (!client) throw new ActError("Pour quel client ?", 428);
      const kind = fileKindOf(req.mime, req.name)!;
      const at = { x: req.x, y: req.y };
      const dataUri = req.data.startsWith("data:") ? req.data : `data:${kind === "image" ? (req.mime || "image/png") : briefMime(req.mime, req.name)};base64,${req.data}`;
      const buf = Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64");
      if (!buf.length) throw new ActError("Fichier vide.", 400);
      if (kind === "image") {
        const created = await deps.createAsset({ clientId: client.clientId, image: dataUri, name: req.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 120) });
        if (!created.ok) throw new ActError(created.error, created.status);
        let link: string | null = null; let driveError = "";
        if (client.dashboardId) {
          try { link = (await deps.driveUpload(client.dashboardId, "creas", { name: req.name, mimeType: dataUri.slice(5, dataUri.indexOf(";")), data: buf })).link; } catch (e) { driveError = toolErrorMessage(e); }
        } else driveError = "client sans dossier Drive";
        const placed = await deps.placeCard({ type: "file", title: req.name, subtitle: `Visuel déposé · ${client.name}${link ? " · dans le Drive « Créas »" : ""}`, clientId: client.id, clientName: client.name, name: req.name, mime: req.mime || "image/png", bytes: req.bytes, image: `/api/studio/assets/${created.assetId}/file?inline=1`, assetId: created.assetId, ...(link ? { link } : {}), folder: "creas" }, at);
        if (!placed) throw new ActError("La carte n'a pas pu être posée.", 500);
        await deps.journal({ kind: "upload", clientId: client.id, cardIds: [placed.id], label: `${shortLabel(req.name)} déposé pour ${client.name}${link ? " (Drive Créas)" : ""}` });
        return { say: `${req.name} est rangé dans les créas de ${client.name}${link ? " et dans son Drive" : driveError ? ` (Drive : ${driveError})` : ""}.`, cardIds: [placed.id], card: placed };
      }
      if (!client.dashboardId) throw new ActError(`${client.name} n'a pas de dossier Drive (client sans dashboard) : le brief ne peut pas y être rangé.`, 400);
      let link: string | null;
      try { link = (await deps.driveUpload(client.dashboardId, "briefs", { name: req.name, mimeType: briefMime(req.mime, req.name), data: buf })).link; }
      catch (e) { throw new ActError(`Le Drive n'a pas répondu : ${toolErrorMessage(e)}`, 502); }
      const placed = await deps.placeCard({ type: "file", title: req.name, subtitle: `Brief · ${client.name} · Drive « Briefs »`, clientId: client.id, clientName: client.name, name: req.name, mime: briefMime(req.mime, req.name), bytes: req.bytes, ...(link ? { link } : {}), folder: "briefs" }, at);
      if (!placed) throw new ActError("La carte n'a pas pu être posée.", 500);
      await deps.journal({ kind: "upload", clientId: client.id, cardIds: [placed.id], label: `Brief ${shortLabel(req.name)} rangé dans le Drive de ${client.name}` });
      return { say: `Le brief est dans le Drive de ${client.name}, dossier Briefs.`, cardIds: [placed.id], card: placed };
    }
  }
}
