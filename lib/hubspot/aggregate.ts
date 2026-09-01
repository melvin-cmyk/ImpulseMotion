/**
 * HubSpot CRM snapshot — PURE aggregation helpers (no I/O, no Date.now()).
 *
 * Everything that turns raw HubSpot objects into a `CrmSnapshot` lives here so
 * it can be unit-tested without mocking fetch. The client (client.ts) only
 * fetches and hands the raw data over.
 */

import type {
  CrmAttributionDiagnostic,
  CrmBucket,
  CrmCampaignRow,
  CrmPipeline,
  CrmSnapshot,
  CrmSource,
  HsObject,
  HsPipelineRaw,
  HsProperty,
  HubspotSourceConfig,
  KnownCampaign,
} from "./types";

// ── Constants ────────────────────────────────────────────────────────────────

export const CRM_SOURCES: CrmSource[] = [
  "PAID_SOCIAL",
  "PAID_SEARCH",
  "ORGANIC_SEARCH",
  "SOCIAL_MEDIA",
  "EMAIL_MARKETING",
  "REFERRALS",
  "DIRECT_TRAFFIC",
  "OTHER_CAMPAIGNS",
  "OFFLINE",
  "UNKNOWN",
];

export const PAID_SOURCES: ReadonlySet<CrmSource> = new Set<CrmSource>(["PAID_SOCIAL", "PAID_SEARCH"]);

/** Lifecycle stages counted as "qualified" when config.qualifiedStageIds is not set. */
export const QUALIFIED_LIFECYCLE_STAGES: ReadonlySet<string> = new Set([
  "marketingqualifiedlead",
  "salesqualifiedlead",
  "opportunity",
  "customer",
]);

/** Standard contact properties always requested (UTM ones are added when detected). */
export const CONTACT_BASE_PROPERTIES = [
  "createdate",
  "lifecyclestage",
  "hs_lead_status",
  "hs_analytics_source",
  "hs_analytics_source_data_1",
  "hs_analytics_source_data_2",
  "hs_latest_source",
  "hs_analytics_first_url",
  "hs_analytics_first_touch_converting_campaign",
] as const;

export const DEAL_PROPERTIES = [
  "dealname",
  "amount",
  "dealstage",
  "pipeline",
  "closedate",
  "createdate",
  "hs_is_closed_won",
  "hs_is_closed",
  "deal_currency_code",
] as const;

/** Share of paid contacts that must match a known campaign to reach level 2. */
export const LEVEL2_MATCH_RATIO = 0.3;
export const MAX_CAMPAIGN_ROWS = 100;

export const SOURCE_LABELS_FR: Record<CrmSource, string> = {
  PAID_SOCIAL: "Paid Social",
  PAID_SEARCH: "Paid Search",
  ORGANIC_SEARCH: "SEO",
  SOCIAL_MEDIA: "Social organique",
  EMAIL_MARKETING: "Email",
  REFERRALS: "Referral",
  DIRECT_TRAFFIC: "Direct",
  OTHER_CAMPAIGNS: "Autres campagnes",
  OFFLINE: "Offline",
  UNKNOWN: "Inconnue",
};

// ── Time bounds ──────────────────────────────────────────────────────────────

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Offset (ms) of `tz` relative to UTC at instant `date` (positive east of UTC). */
function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Epoch ms of `YYYY-MM-DD HH:mm:ss.mmm` interpreted in `tz` (UTC when tz is missing/invalid). */
export function zonedToEpochMs(ymd: string, tz: string | null | undefined, endOfDay: boolean): number {
  if (!YMD_RE.test(ymd)) throw new Error(`Invalid date: ${ymd}`);
  const [y, m, d] = ymd.split("-").map(Number);
  const naive = endOfDay ? Date.UTC(y, m - 1, d, 23, 59, 59, 999) : Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  if (!tz) return naive;
  let offset: number;
  try {
    offset = tzOffsetMs(new Date(naive), tz);
  } catch {
    return naive; // invalid IANA name → UTC
  }
  let ts = naive - offset;
  // second pass for DST transitions around the boundary
  const offset2 = tzOffsetMs(new Date(ts), tz);
  if (offset2 !== offset) ts = naive - offset2;
  return ts;
}

/** [since 00:00:00.000, until 23:59:59.999] in `tz` as epoch ms. */
export function rangeBoundsMs(since: string, until: string, tz?: string | null): { fromMs: number; toMs: number } {
  const fromMs = zonedToEpochMs(since, tz, false);
  const toMs = zonedToEpochMs(until, tz, true);
  if (toMs < fromMs) throw new Error(`Invalid range: ${since} > ${until}`);
  return { fromMs, toMs };
}

/** HubSpot datetime properties come as ISO strings or epoch-ms strings. */
export function parseHsDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const s = String(value).trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function inRange(ms: number | null, bounds: { fromMs: number; toMs: number }): boolean {
  return ms !== null && ms >= bounds.fromMs && ms <= bounds.toMs;
}

// ── Normalisation & matching ─────────────────────────────────────────────────

/**
 * Canonical form used for exact / inclusion matching: URL-decoded, accents
 * stripped, lower-cased, everything but letters and digits removed. Deterministic
 * and punctuation-insensitive ("Prospection_FR-2026" == "prospection fr 2026").
 */
export function normalizeCampaign(value: string | null | undefined): string {
  if (!value) return "";
  let s = String(value);
  try {
    s = decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    // keep raw value when it is not valid percent-encoding
  }
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const MIN_INCLUSION_LEN = 4;

/**
 * Deterministic matching against known ad campaigns:
 * 1. exact on normalised name, or exact on the platform campaign id;
 * 2. inclusion (known name ⊂ value or value ⊂ known name), both ≥ 4 chars once
 *    normalised; the longest known name wins, ties broken alphabetically.
 * No fuzzy / edit-distance matching on purpose.
 */
export function matchCampaign(
  value: string | null | undefined,
  known: KnownCampaign[] | undefined,
): { platform: "meta" | "google"; campaignName: string } | null {
  if (!value || !known?.length) return null;
  const norm = normalizeCampaign(value);
  const rawTrim = String(value).trim();
  if (!norm) return null;

  const sorted = [...known].sort((a, b) => a.name.localeCompare(b.name) || a.platform.localeCompare(b.platform));
  for (const k of sorted) {
    if (normalizeCampaign(k.name) === norm) return { platform: k.platform, campaignName: k.name };
  }
  if (/^\d{6,}$/.test(rawTrim)) {
    for (const k of sorted) {
      if (String(k.id) === rawTrim) return { platform: k.platform, campaignName: k.name };
    }
  }
  if (norm.length < MIN_INCLUSION_LEN) return null;
  let best: KnownCampaign | null = null;
  let bestLen = 0;
  for (const k of sorted) {
    const kn = normalizeCampaign(k.name);
    if (kn.length < MIN_INCLUSION_LEN) continue;
    if (norm.includes(kn) || kn.includes(norm)) {
      if (kn.length > bestLen) {
        best = k;
        bestLen = kn.length;
      }
    }
  }
  return best ? { platform: best.platform, campaignName: best.name } : null;
}

/** `utm_campaign` from a URL's query string (or hash), null when absent/unparseable. */
export function parseUtmCampaignFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = String(url).trim();
  const tryParams = (qs: string): string | null => {
    try {
      const v = new URLSearchParams(qs).get("utm_campaign");
      return v && v.trim() ? v.trim() : null;
    } catch {
      return null;
    }
  };
  try {
    const u = new URL(s.includes("://") ? s : `https://${s}`);
    const fromQuery = tryParams(u.search.replace(/^\?/, ""));
    if (fromQuery) return fromQuery;
    if (u.hash.includes("utm_campaign")) {
      const h = u.hash.slice(1);
      const q = h.indexOf("?");
      return tryParams(q >= 0 ? h.slice(q + 1) : h);
    }
    return null;
  } catch {
    // Not a parseable URL: last-resort regex on the raw string.
    const m = /(?:^|[?&#\s])utm_campaign=([^&#\s]*)/.exec(s);
    if (!m || !m[1]) return null;
    try {
      const v = decodeURIComponent(m[1].replace(/\+/g, " ")).trim();
      return v || null;
    } catch {
      return m[1].trim() || null;
    }
  }
}

export interface UtmProperties {
  campaign: string | null;
  source: string | null;
  medium: string | null;
  content: string | null;
}

const UTM_KEYS: Array<keyof UtmProperties> = ["campaign", "source", "medium", "content"];

/**
 * Finds the contact properties holding UTM values. For each key we prefer, in
 * order: `utm_<key>`, `hs_utm_<key>`, then any property whose name or label
 * contains `utm_<key>` / "utm <key>" (case-insensitive, first alphabetically).
 * `override` (config.utmCampaignProperty) wins for the campaign key when it exists.
 */
export function detectUtmProperties(properties: HsProperty[], override?: string | null): UtmProperties {
  const names = new Map<string, HsProperty>();
  for (const p of properties) if (p?.name) names.set(p.name.toLowerCase(), p);
  const out: UtmProperties = { campaign: null, source: null, medium: null, content: null };
  for (const key of UTM_KEYS) {
    const exact = names.get(`utm_${key}`) ?? names.get(`hs_utm_${key}`);
    if (exact) {
      out[key] = exact.name;
      continue;
    }
    const re = new RegExp(`utm[_\\s-]?${key}`, "i");
    const candidates = properties
      .filter((p) => p?.name && (re.test(p.name) || re.test(p.label ?? "")))
      .map((p) => p.name)
      .sort();
    out[key] = candidates[0] ?? null;
  }
  if (override) {
    const found = names.get(override.toLowerCase());
    if (found) out.campaign = found.name;
  }
  return out;
}

export function mapSource(raw: string | null | undefined): CrmSource {
  if (!raw) return "UNKNOWN";
  const s = String(raw).trim().toUpperCase();
  return (CRM_SOURCES as string[]).includes(s) ? (s as CrmSource) : "UNKNOWN";
}

/** Original source (`hs_analytics_source`), falling back to `hs_latest_source`. */
export function contactSource(contact: HsObject): CrmSource {
  const p = contact.properties ?? {};
  const primary = mapSource(p.hs_analytics_source);
  return primary !== "UNKNOWN" ? primary : mapSource(p.hs_latest_source);
}

export type CampaignOrigin = "utm_property" | "first_url" | "source_data";

/**
 * Campaign of a contact: detected UTM property > utm_campaign parsed from
 * hs_analytics_first_url > hs_analytics_source_data_2 for PAID_* sources.
 */
export function extractContactCampaign(
  contact: HsObject,
  utmCampaignProperty: string | null,
): { campaign: string | null; origin: CampaignOrigin | null } {
  const p = contact.properties ?? {};
  if (utmCampaignProperty) {
    const v = p[utmCampaignProperty];
    if (v && String(v).trim()) return { campaign: String(v).trim(), origin: "utm_property" };
  }
  const fromUrl = parseUtmCampaignFromUrl(p.hs_analytics_first_url);
  if (fromUrl) return { campaign: fromUrl, origin: "first_url" };
  if (PAID_SOURCES.has(contactSource(contact))) {
    const d2 = p.hs_analytics_source_data_2;
    if (d2 && String(d2).trim()) return { campaign: String(d2).trim(), origin: "source_data" };
  }
  return { campaign: null, origin: null };
}

export function isQualifiedLifecycle(stage: string | null | undefined): boolean {
  return !!stage && QUALIFIED_LIFECYCLE_STAGES.has(String(stage).trim().toLowerCase());
}

// ── Buckets ──────────────────────────────────────────────────────────────────

export function emptyBucket(): CrmBucket {
  return { contacts: 0, qualified: 0, dealsCreated: 0, dealsWon: 0, wonAmount: 0, openAmount: 0 };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseAmount(v: string | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isTrue(v: string | null | undefined): boolean {
  return v === "true" || v === "1" || (v as unknown) === true;
}

/** Deal currency = majority of `deal_currency_code`, else config.currency, else null. Never guessed. */
export function pickCurrency(deals: HsObject[], config?: HubspotSourceConfig): string | null {
  const counts = new Map<string, number>();
  for (const d of deals) {
    const c = d.properties?.deal_currency_code;
    if (c && String(c).trim()) {
      const k = String(c).trim().toUpperCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  if (best) return best;
  const cfg = config?.currency?.trim();
  return cfg ? cfg.toUpperCase() : null;
}

export interface StageInfo {
  pipelineId: string;
  isWon: boolean;
  isClosed: boolean;
}

/** Stage id → won/closed flags, from the pipelines API + config overrides. */
export function stageIndex(pipelines: HsPipelineRaw[], config?: HubspotSourceConfig): Map<string, StageInfo> {
  const won = new Set(config?.wonStageIds ?? []);
  const idx = new Map<string, StageInfo>();
  for (const p of pipelines) {
    for (const s of p.stages ?? []) {
      const prob = s.metadata?.probability;
      const probN = prob === undefined || prob === null || prob === "" ? NaN : Number(prob);
      const isWon = won.has(s.id) || probN === 1;
      const closedMeta = s.metadata?.isClosed;
      const isClosed = isWon || closedMeta === true || closedMeta === "true" || probN === 0;
      idx.set(s.id, { pipelineId: p.id, isWon, isClosed });
    }
  }
  return idx;
}

export interface DealFlags {
  createdInRange: boolean;
  wonInRange: boolean;
  isClosed: boolean;
  amount: number;
}

export function dealFlags(
  deal: HsObject,
  bounds: { fromMs: number; toMs: number },
  stages: Map<string, StageInfo>,
  config?: HubspotSourceConfig,
): DealFlags {
  const p = deal.properties ?? {};
  const stage = p.dealstage ? stages.get(p.dealstage) : undefined;
  const wonByStage = !!stage?.isWon || (!!p.dealstage && (config?.wonStageIds ?? []).includes(p.dealstage));
  const isWon = isTrue(p.hs_is_closed_won) || wonByStage;
  const isClosed = isTrue(p.hs_is_closed) || isWon || !!stage?.isClosed;
  return {
    createdInRange: inRange(parseHsDate(p.createdate), bounds),
    wonInRange: isWon && inRange(parseHsDate(p.closedate), bounds),
    isClosed,
    amount: parseAmount(p.amount),
  };
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

export interface BuildSnapshotInput {
  portalId: string;
  fetchedAt: string;
  range: { since: string; until: string };
  tz?: string | null;
  config?: HubspotSourceConfig;
  knownCampaigns?: KnownCampaign[];
  /** Contacts created in range (already filtered by the search API; re-checked here). */
  contacts: HsObject[];
  /** Extra contacts fetched only because a deal points at them (not created in range). */
  relatedContacts?: HsObject[];
  /** Deals created in range ∪ deals won in range (deduplicated by id here). */
  deals: HsObject[];
  /** dealId → contact ids in HubSpot's association order. */
  associations: Map<string, string[]>;
  pipelines: HsPipelineRaw[];
  utmCampaignProperty: string | null;
  warnings?: string[];
  partial?: boolean;
}

interface ContactView {
  id: string;
  source: CrmSource;
  campaign: string | null;
  origin: CampaignOrigin | null;
  campaignKey: string;
  matched: CrmCampaignRow["matched"];
  qualifiedByLifecycle: boolean;
}

/** Pure: raw HubSpot objects → CrmSnapshot. */
export function buildSnapshot(input: BuildSnapshotInput): CrmSnapshot {
  const config = input.config ?? {};
  const bounds = rangeBoundsMs(input.range.since, input.range.until, input.tz);
  const stages = stageIndex(input.pipelines, config);
  const warnings = [...(input.warnings ?? [])];
  const partial = !!input.partial;

  // Contacts: dedupe, keep those created in range, stable sort (createdate, id).
  const contactsById = new Map<string, HsObject>();
  for (const c of input.contacts) if (c?.id && !contactsById.has(c.id)) contactsById.set(c.id, c);
  const contacts = [...contactsById.values()]
    .filter((c) => inRange(parseHsDate(c.properties?.createdate), bounds))
    .sort((a, b) => {
      const da = parseHsDate(a.properties?.createdate) ?? 0;
      const db = parseHsDate(b.properties?.createdate) ?? 0;
      return da - db || compareIds(a.id, b.id);
    });
  const relatedById = new Map<string, HsObject>();
  for (const c of input.relatedContacts ?? []) if (c?.id && !contactsById.has(c.id)) relatedById.set(c.id, c);

  const view = (c: HsObject): ContactView => {
    const source = contactSource(c);
    const { campaign, origin } = extractContactCampaign(c, input.utmCampaignProperty);
    return {
      id: c.id,
      source,
      campaign,
      origin,
      campaignKey: normalizeCampaign(campaign),
      matched: matchCampaign(campaign, input.knownCampaigns),
      qualifiedByLifecycle: isQualifiedLifecycle(c.properties?.lifecyclestage),
    };
  };
  const views = new Map<string, ContactView>();
  for (const c of contacts) views.set(c.id, view(c));
  for (const c of relatedById.values()) views.set(c.id, view(c));

  // Deals: dedupe, flags, attribution = first associated contact.
  const dealsById = new Map<string, HsObject>();
  for (const d of input.deals) if (d?.id && !dealsById.has(d.id)) dealsById.set(d.id, d);
  const pipelineFilter = config.pipelineIds?.length ? new Set(config.pipelineIds) : null;
  const qualifiedStages = config.qualifiedStageIds?.length ? new Set(config.qualifiedStageIds) : null;
  // Only deals created OR won inside the range belong to the snapshot.
  const deals = [...dealsById.values()]
    .filter((d) => !pipelineFilter || (d.properties?.pipeline ? pipelineFilter.has(d.properties.pipeline) : false))
    .filter((d) => {
      const f = dealFlags(d, bounds, stages, config);
      return f.createdInRange || f.wonInRange;
    })
    .sort((a, b) => compareIds(a.id, b.id));

  const qualifiedByDeal = new Set<string>();
  const dealAttribution = new Map<string, ContactView | null>();
  let dealsWithoutContact = 0;
  for (const d of deals) {
    const contactIds = input.associations.get(d.id) ?? [];
    const first = contactIds.map((id) => views.get(id) ?? null).find((v) => v !== null) ?? null;
    dealAttribution.set(d.id, first);
    if (!contactIds.length) dealsWithoutContact++;
    if (qualifiedStages && d.properties?.dealstage) {
      const flags = dealFlags(d, bounds, stages, config);
      const reaches = qualifiedStages.has(d.properties.dealstage) || flags.wonInRange || !!stages.get(d.properties.dealstage)?.isWon;
      if (reaches) for (const id of contactIds) qualifiedByDeal.add(id);
    }
  }

  const isQualified = (v: ContactView): boolean => (qualifiedStages ? qualifiedByDeal.has(v.id) : v.qualifiedByLifecycle);

  // Aggregation.
  const totals = emptyBucket();
  const bySource: Partial<Record<CrmSource, CrmBucket>> = {};
  const byCampaign = new Map<string, CrmCampaignRow & { _sources: Map<CrmSource, number> }>();
  const bucketFor = (src: CrmSource): CrmBucket => (bySource[src] ??= emptyBucket());
  const rowFor = (v: ContactView) => {
    let row = byCampaign.get(v.campaignKey);
    if (!row) {
      row = { ...emptyBucket(), campaign: v.campaign ?? "", source: v.source, matched: v.matched, _sources: new Map() };
      byCampaign.set(v.campaignKey, row);
    }
    return row;
  };

  const diag: CrmAttributionDiagnostic = {
    level: 0,
    contactsTotal: contacts.length,
    withSource: 0,
    paidSource: 0,
    withUtmCampaign: 0,
    matchedToCampaign: 0,
    utmProperty: input.utmCampaignProperty,
    recommendations: [],
  };
  const paidWithoutUtm = new Map<CrmSource, number>();
  const paidBySource = new Map<CrmSource, number>();
  const unmatchedCampaigns = new Set<string>();

  for (const c of contacts) {
    const v = views.get(c.id)!;
    const q = isQualified(v);
    totals.contacts++;
    if (q) totals.qualified++;
    const b = bucketFor(v.source);
    b.contacts++;
    if (q) b.qualified++;
    if (v.source !== "UNKNOWN") diag.withSource++;
    const paid = PAID_SOURCES.has(v.source);
    if (paid) {
      diag.paidSource++;
      paidBySource.set(v.source, (paidBySource.get(v.source) ?? 0) + 1);
    }
    if (v.origin === "utm_property" || v.origin === "first_url") diag.withUtmCampaign++;
    if (v.matched) diag.matchedToCampaign++;
    if (paid && v.origin !== "utm_property" && v.origin !== "first_url") {
      paidWithoutUtm.set(v.source, (paidWithoutUtm.get(v.source) ?? 0) + 1);
    }
    if (v.campaign && !v.matched && paid) unmatchedCampaigns.add(v.campaign);
    if (v.campaignKey) {
      const row = rowFor(v);
      row.contacts++;
      if (q) row.qualified++;
      row._sources.set(v.source, (row._sources.get(v.source) ?? 0) + 1);
    }
  }

  const stageCounts = new Map<string, { count: number; amount: number }>();
  for (const d of deals) {
    const f = dealFlags(d, bounds, stages, config);
    const attr = dealAttribution.get(d.id) ?? null;
    const src: CrmSource = attr?.source ?? "UNKNOWN";
    const targets: CrmBucket[] = [totals, bucketFor(src)];
    if (attr?.campaignKey) targets.push(rowFor(attr));
    for (const t of targets) {
      if (f.createdInRange) {
        t.dealsCreated++;
        if (!f.isClosed) t.openAmount = round2(t.openAmount + f.amount);
      }
      if (f.wonInRange) {
        t.dealsWon++;
        t.wonAmount = round2(t.wonAmount + f.amount);
      }
    }
    const stageId = d.properties?.dealstage;
    if (stageId) {
      const sc = stageCounts.get(stageId) ?? { count: 0, amount: 0 };
      sc.count++;
      sc.amount = round2(sc.amount + f.amount);
      stageCounts.set(stageId, sc);
    }
  }

  // byCampaign: majority source per row, sort contacts desc then name, cap.
  const campaignRows: CrmCampaignRow[] = [...byCampaign.values()]
    .map((r) => {
      let best: CrmSource = r.source;
      let bestN = -1;
      for (const s of CRM_SOURCES) {
        const n = r._sources.get(s) ?? 0;
        if (n > bestN) {
          best = s;
          bestN = n;
        }
      }
      return {
        campaign: r.campaign,
        source: bestN > 0 ? best : r.source,
        matched: r.matched,
        contacts: r.contacts,
        qualified: r.qualified,
        dealsCreated: r.dealsCreated,
        dealsWon: r.dealsWon,
        wonAmount: r.wonAmount,
        openAmount: r.openAmount,
      };
    })
    .sort((a, b) => b.contacts - a.contacts || b.dealsWon - a.dealsWon || a.campaign.localeCompare(b.campaign));
  if (campaignRows.length > MAX_CAMPAIGN_ROWS) {
    warnings.push(`${campaignRows.length} campagnes distinctes dans le CRM ; seules les ${MAX_CAMPAIGN_ROWS} premières sont listées.`);
  }

  // Pipelines.
  const pipelines: CrmPipeline[] = input.pipelines
    .filter((p) => !pipelineFilter || pipelineFilter.has(p.id))
    .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.label.localeCompare(b.label))
    .map((p) => ({
      id: p.id,
      label: p.label,
      stages: [...(p.stages ?? [])]
        .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
        .map((s) => {
          const info = stages.get(s.id)!;
          const sc = stageCounts.get(s.id) ?? { count: 0, amount: 0 };
          return { id: s.id, label: s.label, isWon: info.isWon, isClosed: info.isClosed, count: sc.count, amount: sc.amount };
        }),
    }));

  if (dealsWithoutContact > 0) {
    warnings.push(`${dealsWithoutContact} deal(s) sans contact associé : comptés en source « Inconnue ».`);
  }

  // Diagnostic level + recommendations.
  diag.level = diagnosticLevel(diag);
  diag.recommendations = buildRecommendations(diag, {
    paidWithoutUtm,
    paidBySource,
    unmatchedCampaigns: [...unmatchedCampaigns].sort(),
    hasKnownCampaigns: !!input.knownCampaigns?.length,
  });
  if (partial && !warnings.length) warnings.push("Données CRM partielles.");

  return {
    fetchedAt: input.fetchedAt,
    range: { ...input.range },
    currency: pickCurrency(deals, config),
    portalId: input.portalId,
    totals,
    bySource,
    byCampaign: campaignRows.slice(0, MAX_CAMPAIGN_ROWS),
    pipelines,
    diagnostic: diag,
    partial,
    warnings,
  };
}

function compareIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

/** 0 = no contacts / no source at all; 1 = sources known; 2 = ≥30 % of paid contacts matched to a known campaign. */
export function diagnosticLevel(
  d: Pick<CrmAttributionDiagnostic, "contactsTotal" | "withSource" | "paidSource" | "matchedToCampaign">,
): 0 | 1 | 2 {
  if (d.contactsTotal === 0 || d.withSource === 0) return 0;
  if (d.paidSource > 0 && d.matchedToCampaign / d.paidSource >= LEVEL2_MATCH_RATIO) return 2;
  return 1;
}

function pct(n: number, total: number): number {
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

/** French, actionable recommendations for the consultant. */
export function buildRecommendations(
  d: CrmAttributionDiagnostic,
  ctx: {
    paidWithoutUtm: Map<CrmSource, number>;
    paidBySource: Map<CrmSource, number>;
    unmatchedCampaigns: string[];
    hasKnownCampaigns: boolean;
  },
): string[] {
  const rec: string[] = [];
  if (d.contactsTotal === 0) {
    rec.push("Aucun contact créé dans HubSpot sur la période : vérifier la connexion formulaires/CRM ou élargir la période.");
    return rec;
  }
  if (d.withSource === 0) {
    rec.push(
      "Aucun contact n'a de source d'origine (hs_analytics_source) : installer le code de suivi HubSpot sur le site et vérifier que les formulaires sont bien des formulaires HubSpot (ou l'API forms).",
    );
    return rec;
  }
  if (d.paidSource === 0) {
    rec.push(
      "Aucun contact n'est attribué à une source payante (PAID_SOCIAL / PAID_SEARCH) : vérifier que les URL des annonces pointent vers des pages avec le suivi HubSpot et portent utm_source / utm_medium.",
    );
  }
  if (!d.utmProperty) {
    rec.push(
      "Aucune propriété contact utm_campaign détectée dans HubSpot : créer une propriété « utm_campaign » (champ caché de formulaire ou paramètre de suivi) pour une attribution par campagne fiable.",
    );
  }
  for (const [src, n] of [...ctx.paidWithoutUtm.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const hint =
      src === "PAID_SOCIAL"
        ? "faire poser utm_campaign={{campaign.name}} dans les URL des annonces Meta (paramètres d'URL au niveau de l'annonce)"
        : "faire poser utm_campaign={campaignid} (ou le nom de campagne) dans le modèle de suivi Google Ads";
    const share = pct(n, ctx.paidBySource.get(src) ?? d.paidSource);
    rec.push(`${share} % des contacts ${SOURCE_LABELS_FR[src]} n'ont pas d'utm_campaign : ${hint}.`);
  }
  if (!ctx.hasKnownCampaigns && d.withUtmCampaign > 0) {
    rec.push("Aucune campagne Meta/Google connue pour ce client : relier un compte publicitaire au dashboard pour activer le rapprochement.");
  } else if (ctx.unmatchedCampaigns.length > 0) {
    const sample = ctx.unmatchedCampaigns.slice(0, 5).map((c) => `« ${c} »`).join(", ");
    rec.push(
      `${ctx.unmatchedCampaigns.length} valeur(s) de campagne CRM ne correspondent à aucune campagne Meta/Google (${sample}) : reprendre le nom exact de la campagne dans utm_campaign.`,
    );
  }
  if (d.level === 2 && d.paidSource > 0 && d.matchedToCampaign < d.paidSource) {
    rec.push(
      `${pct(d.matchedToCampaign, d.paidSource)} % des contacts paid sont rattachés à une campagne connue ; le reste est agrégé par source uniquement.`,
    );
  }
  return rec;
}
