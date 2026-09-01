/**
 * HubSpot CRM client — fetches contacts / deals / pipelines for a period and
 * hands them to the pure aggregator (aggregate.ts).
 *
 * Endpoints (all under https://api.hubapi.com, private-app Bearer token):
 * - GET  /account-info/v3/details                       portalId, uiDomain, timeZone
 * - GET  /crm/v3/properties/contacts                    detect utm_* properties
 * - POST /crm/v3/objects/contacts/search                contacts created in range
 * - POST /crm/v3/objects/deals/search                   deals created / won in range
 * - POST /crm/v4/associations/deals/contacts/batch/read deal → contacts (batches of 100)
 * - POST /crm/v3/objects/contacts/batch/read            contacts referenced by deals but created before the range
 * - GET  /crm/v3/pipelines/deals                        stage labels + won/closed flags
 *
 * Failure policy: a 401 (token) or a contacts-search failure propagates (nothing
 * useful can be built). Every other step degrades into `warnings` + `partial: true`.
 */

import { createHash } from "node:crypto";
import { cached, ttlForRange } from "@/lib/kpi-cache";
import {
  CONTACT_BASE_PROPERTIES,
  DEAL_PROPERTIES,
  buildSnapshot,
  detectUtmProperties,
  rangeBoundsMs,
} from "./aggregate";
import { chunk, hubspotFetch, isHubspotApiError } from "./http";
import type {
  CrmSnapshot,
  HsAssociationBatchResponse,
  HsObject,
  HsPipelineRaw,
  HsProperty,
  HsSearchResponse,
  HubspotSourceConfig,
  KnownCampaign,
} from "./types";

export type { CrmSnapshot } from "./types";

/** HubSpot search API hard cap: `after` + `limit` may not exceed 10 000. */
export const SEARCH_MAX_RESULTS = 10_000;
export const SEARCH_PAGE_SIZE = 200;
export const BATCH_SIZE = 100;

/** Scopes the private app must have; each is probed by `testHubspotConnection`. */
export const REQUIRED_SCOPES: Array<{ scope: string; probe: string; label: string }> = [
  { scope: "crm.objects.contacts.read", probe: "/crm/v3/objects/contacts", label: "contacts" },
  { scope: "crm.objects.deals.read", probe: "/crm/v3/objects/deals", label: "deals" },
  { scope: "crm.schemas.deals.read", probe: "/crm/v3/pipelines/deals", label: "pipelines" },
  { scope: "crm.schemas.contacts.read", probe: "/crm/v3/properties/contacts", label: "propriétés contacts" },
];

interface AccountDetails {
  portalId?: number | string;
  uiDomain?: string;
  timeZone?: string;
  currency?: string;
}

export type TestConnectionResult =
  | { ok: true; portalId: string; hubDomain: string | null; scopesOk: boolean; missingScopes: string[]; timeZone: string | null }
  | { ok: false; error: string };

/** Validates a private-app token: portal identity + one read probe per required scope. */
export async function testHubspotConnection(token: string): Promise<TestConnectionResult> {
  if (!token || !token.trim()) return { ok: false, error: "Token HubSpot vide." };
  let details: AccountDetails;
  try {
    details = await hubspotFetch<AccountDetails>(token, "/account-info/v3/details");
  } catch (e) {
    if (isHubspotApiError(e)) {
      // Fallback for portals where account-info is not readable: legacy /integrations/v1/me.
      if (e.category === "scope" || e.category === "permission" || e.category === "not_found") {
        try {
          details = await hubspotFetch<AccountDetails>(token, "/integrations/v1/me");
        } catch (e2) {
          return { ok: false, error: isHubspotApiError(e2) ? e2.userMessage() : String(e2) };
        }
      } else {
        return { ok: false, error: e.userMessage() };
      }
    } else {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const portalId = details?.portalId !== undefined && details.portalId !== null ? String(details.portalId) : "";
  if (!portalId) return { ok: false, error: "HubSpot n'a pas renvoyé de portalId pour ce token." };

  const missing = new Set<string>();
  const probes = await Promise.all(
    REQUIRED_SCOPES.map(async (s) => {
      try {
        await hubspotFetch(token, s.probe, { query: { limit: 1 } });
        return null;
      } catch (e) {
        return { s, e };
      }
    }),
  );
  for (const p of probes) {
    if (!p) continue;
    if (isHubspotApiError(p.e)) {
      if (p.e.category === "auth") return { ok: false, error: p.e.userMessage() };
      if (p.e.category === "scope" || p.e.category === "permission") {
        if (p.e.missingScopes.length) p.e.missingScopes.forEach((m) => missing.add(m));
        else missing.add(p.s.scope);
        continue;
      }
      // Rate limit / 5xx after retries: fail loudly rather than reporting a bogus scope.
      return { ok: false, error: `Vérification « ${p.s.label} » impossible : ${p.e.userMessage()}` };
    }
    return { ok: false, error: p.e instanceof Error ? p.e.message : String(p.e) };
  }
  const missingScopes = [...missing].sort();
  return {
    ok: true,
    portalId,
    hubDomain: details.uiDomain ?? null,
    scopesOk: missingScopes.length === 0,
    missingScopes,
    timeZone: details.timeZone ?? null,
  };
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

interface SearchFilter {
  propertyName: string;
  operator: "BETWEEN" | "EQ" | "IN" | "GTE" | "LTE";
  value?: string;
  highValue?: string;
  values?: string[];
}

interface SearchAllResult {
  results: HsObject[];
  total: number;
  truncated: boolean;
}

/** Paginates a CRM search (limit 200) until exhausted or the 10 000 cap. */
export async function searchAll(
  token: string,
  objectType: "contacts" | "deals",
  filters: SearchFilter[],
  properties: readonly string[],
  sortProperty: string = "createdate",
): Promise<SearchAllResult> {
  const out: HsObject[] = [];
  let after: string | undefined;
  let total = 0;
  let truncated = false;
  const seen = new Set<string>();
  for (let page = 0; page < SEARCH_MAX_RESULTS / SEARCH_PAGE_SIZE + 1; page++) {
    const body: Record<string, unknown> = {
      filterGroups: [{ filters }],
      properties: [...properties],
      sorts: [{ propertyName: sortProperty, direction: "ASCENDING" }],
      limit: SEARCH_PAGE_SIZE,
      ...(after ? { after } : {}),
    };
    const res = await hubspotFetch<HsSearchResponse>(token, `/crm/v3/objects/${objectType}/search`, { body });
    total = typeof res.total === "number" ? res.total : total;
    for (const r of res.results ?? []) {
      if (r?.id && !seen.has(r.id)) {
        seen.add(r.id);
        out.push({ id: String(r.id), properties: r.properties ?? {} });
      }
    }
    const next = res.paging?.next?.after;
    if (!next) break;
    if (Number(next) >= SEARCH_MAX_RESULTS || out.length >= SEARCH_MAX_RESULTS) {
      truncated = true;
      break;
    }
    after = String(next);
  }
  if (total > out.length) truncated = true;
  return { results: out, total: Math.max(total, out.length), truncated };
}

/** deals → contacts associations, batches of 100, HubSpot order preserved. */
export async function fetchDealContactAssociations(token: string, dealIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!dealIds.length) return map;
  const batches = chunk(dealIds, BATCH_SIZE);
  const responses = await Promise.all(
    batches.map((ids) =>
      hubspotFetch<HsAssociationBatchResponse>(token, "/crm/v4/associations/deals/contacts/batch/read", {
        body: { inputs: ids.map((id) => ({ id })) },
      }),
    ),
  );
  for (const res of responses) {
    for (const r of res?.results ?? []) {
      const from = String(r.from?.id ?? "");
      if (!from) continue;
      const to = (r.to ?? []).map((t) => String(t.toObjectId)).filter(Boolean);
      const existing = map.get(from) ?? [];
      map.set(from, [...existing, ...to.filter((id) => !existing.includes(id))]);
    }
  }
  return map;
}

/** Batch read of contacts by id (100 per call). */
export async function fetchContactsByIds(token: string, ids: string[], properties: readonly string[]): Promise<HsObject[]> {
  if (!ids.length) return [];
  const responses = await Promise.all(
    chunk(ids, BATCH_SIZE).map((batch) =>
      hubspotFetch<{ results?: HsObject[] }>(token, "/crm/v3/objects/contacts/batch/read", {
        body: { properties: [...properties], inputs: batch.map((id) => ({ id })) },
      }),
    ),
  );
  const out: HsObject[] = [];
  for (const res of responses) {
    for (const r of res?.results ?? []) if (r?.id) out.push({ id: String(r.id), properties: r.properties ?? {} });
  }
  return out;
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

export interface FetchCrmSnapshotInput {
  token: string;
  since: string;
  until: string;
  config?: HubspotSourceConfig;
  knownCampaigns?: KnownCampaign[];
  /** IANA timezone used for the day boundaries (default: portal timeZone, else UTC). */
  tz?: string | null;
  /** Injectable clock for tests. */
  now?: Date;
}

function describeError(e: unknown): string {
  if (isHubspotApiError(e)) return e.userMessage();
  return e instanceof Error ? e.message : String(e);
}

/** Rethrows token errors; every other error is returned so the caller can degrade. */
function rethrowIfAuth(e: unknown): void {
  if (isHubspotApiError(e) && e.category === "auth") throw e;
}

export async function fetchCrmSnapshot(input: FetchCrmSnapshotInput): Promise<CrmSnapshot> {
  const { token, since, until } = input;
  const config = input.config ?? {};
  const warnings: string[] = [];
  let partial = false;
  const now = input.now ?? new Date();

  // 0. Portal identity (+ timezone when not provided).
  let portalId = "";
  let tz: string | null = input.tz ?? null;
  try {
    const details = await hubspotFetch<AccountDetails>(token, "/account-info/v3/details");
    portalId = details?.portalId !== undefined ? String(details.portalId) : "";
    if (!tz && details?.timeZone) tz = details.timeZone;
  } catch (e) {
    rethrowIfAuth(e);
    warnings.push(`Identité du portail HubSpot non lue : ${describeError(e)}`);
  }
  const bounds = rangeBoundsMs(since, until, tz);
  const from = String(bounds.fromMs);
  const to = String(bounds.toMs);

  // a. Contact properties → UTM detection.
  let utm = detectUtmProperties([], config.utmCampaignProperty);
  let utmDetected = false;
  try {
    const res = await hubspotFetch<{ results?: HsProperty[] }>(token, "/crm/v3/properties/contacts");
    utm = detectUtmProperties(res?.results ?? [], config.utmCampaignProperty);
    utmDetected = true;
    if (config.utmCampaignProperty && utm.campaign !== config.utmCampaignProperty) {
      warnings.push(`La propriété utm configurée « ${config.utmCampaignProperty} » n'existe pas dans HubSpot ; détection automatique utilisée.`);
    }
  } catch (e) {
    rethrowIfAuth(e);
    partial = true;
    warnings.push(`Propriétés contacts non lues (scope crm.schemas.contacts.read ?) : ${describeError(e)} — attribution UTM limitée aux URL de première visite.`);
  }
  const contactProps: string[] = [...CONTACT_BASE_PROPERTIES];
  if (utmDetected) {
    for (const p of [utm.campaign, utm.source, utm.medium, utm.content]) {
      if (p && !contactProps.includes(p)) contactProps.push(p);
    }
  }

  // b. Contacts created in range — required, propagates on failure.
  const contactsRes = await searchAll(
    token,
    "contacts",
    [{ propertyName: "createdate", operator: "BETWEEN", value: from, highValue: to }],
    contactProps,
  );
  if (contactsRes.truncated) {
    partial = true;
    warnings.push(
      `Plus de ${SEARCH_MAX_RESULTS.toLocaleString("fr-FR")} contacts créés sur la période (${contactsRes.total.toLocaleString("fr-FR")}) : l'API de recherche HubSpot plafonne à ${SEARCH_MAX_RESULTS.toLocaleString("fr-FR")} résultats, réduire la période.`,
    );
  }

  // c. Deals created in range ∪ deals won in range.
  const pipelineFilter: SearchFilter[] = config.pipelineIds?.length
    ? [{ propertyName: "pipeline", operator: "IN", values: config.pipelineIds }]
    : [];
  let deals: HsObject[] = [];
  let dealsOk = false;
  try {
    const [created, won] = await Promise.all([
      searchAll(token, "deals", [{ propertyName: "createdate", operator: "BETWEEN", value: from, highValue: to }, ...pipelineFilter], DEAL_PROPERTIES),
      searchAll(
        token,
        "deals",
        [
          { propertyName: "closedate", operator: "BETWEEN", value: from, highValue: to },
          { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
          ...pipelineFilter,
        ],
        DEAL_PROPERTIES,
        "closedate",
      ),
    ]);
    deals = [...created.results, ...won.results];
    dealsOk = true;
    if (created.truncated || won.truncated) {
      partial = true;
      warnings.push(`Plus de ${SEARCH_MAX_RESULTS.toLocaleString("fr-FR")} deals sur la période : liste tronquée par l'API HubSpot, réduire la période.`);
    }
  } catch (e) {
    rethrowIfAuth(e);
    partial = true;
    warnings.push(`Deals non lus (scope crm.objects.deals.read ?) : ${describeError(e)}`);
  }

  // c'. Associations deals → contacts + contacts created before the range.
  let associations = new Map<string, string[]>();
  let relatedContacts: HsObject[] = [];
  if (dealsOk && deals.length) {
    const dealIds = [...new Set(deals.map((d) => d.id))];
    try {
      associations = await fetchDealContactAssociations(token, dealIds);
    } catch (e) {
      rethrowIfAuth(e);
      partial = true;
      warnings.push(`Associations deals → contacts non lues : ${describeError(e)} — deals comptés en source « Inconnue ».`);
    }
    const known = new Set(contactsRes.results.map((c) => c.id));
    const missing = [...new Set([...associations.values()].flat())].filter((id) => !known.has(id));
    if (missing.length) {
      try {
        relatedContacts = await fetchContactsByIds(token, missing, contactProps);
      } catch (e) {
        rethrowIfAuth(e);
        partial = true;
        warnings.push(`${missing.length} contact(s) liés à des deals non lus : ${describeError(e)}`);
      }
    }
  }

  // d. Pipelines.
  let pipelines: HsPipelineRaw[] = [];
  try {
    const res = await hubspotFetch<{ results?: HsPipelineRaw[] }>(token, "/crm/v3/pipelines/deals");
    pipelines = res?.results ?? [];
  } catch (e) {
    rethrowIfAuth(e);
    partial = true;
    warnings.push(`Pipelines non lus (scope crm.schemas.deals.read ?) : ${describeError(e)} — statut « gagné » déduit de hs_is_closed_won uniquement.`);
  }

  // e/f. Pure aggregation.
  return buildSnapshot({
    portalId,
    fetchedAt: now.toISOString(),
    range: { since, until },
    tz,
    config,
    knownCampaigns: input.knownCampaigns,
    contacts: contactsRes.results,
    relatedContacts,
    deals,
    associations,
    pipelines,
    utmCampaignProperty: utm.campaign,
    warnings,
    partial,
  });
}

// ── Cache ────────────────────────────────────────────────────────────────────

export interface GetCrmSnapshotCachedInput extends FetchCrmSnapshotInput {
  dashboardId: string;
  refresh?: boolean;
}

/** Short, stable hash of the inputs that change the result (config + known campaigns). */
export function snapshotConfigHash(config: HubspotSourceConfig | undefined, known: KnownCampaign[] | undefined, tz?: string | null): string {
  const cfg = config ?? {};
  const canonical = {
    pipelineIds: [...(cfg.pipelineIds ?? [])].sort(),
    qualifiedStageIds: [...(cfg.qualifiedStageIds ?? [])].sort(),
    wonStageIds: [...(cfg.wonStageIds ?? [])].sort(),
    currency: cfg.currency ?? null,
    utmCampaignProperty: cfg.utmCampaignProperty ?? null,
    tz: tz ?? null,
    known: (known ?? []).map((k) => `${k.platform}:${k.id}:${k.name}`).sort(),
  };
  return createHash("sha1").update(JSON.stringify(canonical)).digest("hex").slice(0, 12);
}

export function snapshotCacheKey(input: Pick<GetCrmSnapshotCachedInput, "dashboardId" | "since" | "until" | "config" | "knownCampaigns" | "tz">): string {
  return `hubspot:snapshot:${input.dashboardId}:${input.since}_${input.until}:${snapshotConfigHash(input.config, input.knownCampaigns, input.tz)}`;
}

export async function getCrmSnapshotCached(input: GetCrmSnapshotCachedInput): Promise<CrmSnapshot & { cached: boolean }> {
  const key = snapshotCacheKey(input);
  let fetched = false;
  const snapshot = await cached<CrmSnapshot>(
    key,
    async () => {
      fetched = true;
      return fetchCrmSnapshot(input);
    },
    { ttlMs: ttlForRange({ since: input.since, until: input.until }, { tz: input.tz ?? null, now: input.now }), refresh: input.refresh },
  );
  return { ...snapshot, cached: !fetched };
}
