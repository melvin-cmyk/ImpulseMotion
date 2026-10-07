/**
 * Pilotage on Meta: the structure of an account (campaigns, ad sets, ads with
 * their budgets and last 7 days' spend), one object as it is now, and one
 * field written then read back.
 *
 * Every object read for a change carries its `account_id`: an object of
 * another account than the one of the action is refused, whatever the page sent.
 */

import { getMetaSystemToken, metaGraphGetAll, metaGraphGetOnce, metaGraphUpdate, metaGraphUpdateFields, metaGraphCopy, isMetaWriteUncertain } from "@/lib/meta-api";
import { isMetaApiError } from "@/lib/meta-errors";
import { metaAccountDigits } from "@/lib/routines/accounts";
import { metaGraphPost } from "@/lib/meta-api";
import { metaStoryWithTexts, readMetaCreative, type MetaAdCreative, type MetaAdTexts } from "@/lib/pilot/creative";
import type { WriteGuard } from "@/lib/routines/types";
import type { PilotObjectState, PilotObjectType } from "@/lib/pilot/ops";

const SPEND_7D = "insights.date_preset(last_7d){spend}";
const LIVE_STATUSES = JSON.stringify([{ field: "effective_status", operator: "NOT_IN", value: ["DELETED", "ARCHIVED"] }]);

const FIELDS: Record<Exclude<PilotObjectType, "keyword">, string> = {
  campaign: "id,account_id,name,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,spend_cap,bid_strategy,bid_amount,bid_constraints",
  adset: "id,account_id,name,status,effective_status,daily_budget,lifetime_budget,start_time,end_time,bid_amount,bid_strategy,bid_constraints,targeting,campaign{name}",
  ad: "id,account_id,name,status,effective_status,adset{name},creative{id,name,object_story_spec}",
};
/** Meta's « no cap » marker on spend_cap. */
const NO_SPEND_CAP = 922337203685478;

type Raw = Record<string, unknown> & {
  id: string; name?: string; status?: string; effective_status?: string; account_id?: string;
  daily_budget?: string; lifetime_budget?: string; stop_time?: string; end_time?: string; start_time?: string; bid_amount?: number | string;
  spend_cap?: string | number; bid_strategy?: string; bid_constraints?: { roas_average_floor?: number | string }; targeting?: Record<string, unknown>; campaign_id?: string; adset_id?: string;
  campaign?: { name?: string }; adset?: { name?: string };
  creative?: { id?: string; name?: string; object_story_spec?: Record<string, unknown> };
  insights?: { data?: Array<{ spend?: string }> };
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The editable texts of an ad's creative as JSON; null when the creative is not an image/video link ad. */
function adTextsJson(creative: Raw["creative"]): string | null {
  const c = readMetaCreative(creative as Parameters<typeof readMetaCreative>[0]);
  if (!c) return null;
  const texts: MetaAdTexts = { kind: c.kind, primaryText: c.primaryText, headline: c.headline, description: c.description, linkUrl: c.linkUrl, callToAction: c.callToAction };
  return JSON.stringify(texts);
}

export function toState(raw: Raw, type: Exclude<PilotObjectType, "keyword">): PilotObjectState {
  return {
    id: String(raw.id),
    type,
    accountId: metaAccountDigits(raw.account_id) ?? "",
    name: String(raw.name ?? ""),
    status: String(raw.status ?? ""),
    effectiveStatus: String(raw.effective_status ?? raw.status ?? ""),
    dailyBudget: num(raw.daily_budget),
    lifetimeBudget: num(raw.lifetime_budget),
    endTime: (type === "campaign" ? raw.stop_time : raw.end_time) || null,
    startTime: type === "ad" ? null : raw.start_time || null,
    bidAmount: type === "adset" ? num(raw.bid_amount) : null,
    bidStrategy: type === "ad" ? null : raw.bid_strategy ?? null,
    // The cap is the bid under COST_CAP; the floor is bid_constraints under MIN_ROAS, ×10 000 at Meta.
    targetCpa: type !== "ad" && raw.bid_strategy === "COST_CAP" ? num(raw.bid_amount) : null,
    targetRoas: type !== "ad" && raw.bid_strategy === "LOWEST_COST_WITH_MIN_ROAS" && num(raw.bid_constraints?.roas_average_floor) ? Math.round(Number(raw.bid_constraints!.roas_average_floor) / 100) / 100 : null,
    spendCap: type === "campaign" && num(raw.spend_cap) && Number(raw.spend_cap) < NO_SPEND_CAP ? num(raw.spend_cap) : null,
    strategyLock: null,
    targeting: type === "adset" && raw.targeting && typeof raw.targeting === "object" ? JSON.stringify(raw.targeting) : null,
    creativeId: type === "ad" && raw.creative?.id ? String(raw.creative.id) : null,
    adTexts: type === "ad" ? adTextsJson(raw.creative) : null,
    parentName: type === "adset" ? raw.campaign?.name ?? "" : type === "ad" ? raw.adset?.name ?? "" : "",
  };
}

export interface StructureRow extends PilotObjectState {
  parentId: string | null;
  bidStrategy: string | null;
  spend7d: number;
}

const spendOf = (raw: Raw) => Number(raw.insights?.data?.[0]?.spend ?? 0) || 0;

function row(raw: Raw, type: Exclude<PilotObjectType, "keyword">, parentId: string | null): StructureRow {
  return { ...toState(raw, type), parentId, bidStrategy: raw.bid_strategy ?? null, spend7d: spendOf(raw) };
}

/** Campaigns and ad sets of the account that are not deleted or archived. */
export async function readStructure(accountId: string): Promise<{ campaigns: StructureRow[]; adsets: StructureRow[]; truncated: boolean }> {
  const digits = metaAccountDigits(accountId);
  if (!digits) throw new Error("Compte Meta invalide");
  const token = getMetaSystemToken();
  const [campaigns, adsets] = await Promise.all([
    metaGraphGetAll<Raw>(`/act_${digits}/campaigns`, token, { fields: `${FIELDS.campaign},${SPEND_7D}`, filtering: LIVE_STATUSES, limit: "200" }, 1000),
    // The targeting spec is heavy: read on the single object (readObject), not on the whole tree.
    metaGraphGetAll<Raw>(`/act_${digits}/adsets`, token, { fields: `${FIELDS.adset.replace(",targeting", "")},campaign_id,${SPEND_7D}`, filtering: LIVE_STATUSES, limit: "200" }, 2000),
  ]);
  return {
    campaigns: campaigns.data.map((r) => row(r, "campaign", null)),
    adsets: adsets.data.map((r) => row(r, "adset", r.campaign_id ?? null)),
    truncated: campaigns.truncated || adsets.truncated,
  };
}

/** The ads of one ad set (read when it is opened). */
export async function readAds(adsetId: string): Promise<StructureRow[]> {
  if (!/^\d{5,25}$/.test(adsetId)) throw new Error("Ensemble de publicités invalide");
  const ads = await metaGraphGetAll<Raw>(`/${adsetId}/ads`, getMetaSystemToken(), { fields: `${FIELDS.ad},${SPEND_7D}`, filtering: LIVE_STATUSES, limit: "100" }, 500);
  return ads.data.map((r) => row(r, "ad", adsetId));
}

/**
 * One object as Meta holds it now; null only when Meta says it does not exist
 * (code 100, subcode 33). Quota, token or permission errors are thrown: they
 * say nothing of the object.
 */
export async function readObject(objectId: string, type: PilotObjectType): Promise<PilotObjectState | null> {
  if (type === "keyword") return null;
  try {
    const raw = await metaGraphGetOnce<Raw>(`/${objectId}`, getMetaSystemToken(), { fields: FIELDS[type] });
    return raw && raw.id ? toState(raw, type) : null;
  } catch (e) {
    if (isMetaApiError(e) && e.code === 100 && e.subcode === 33) return null;
    throw e;
  }
}

/** The currency of the account as Meta holds it: budgets are written in its minor units. */
export async function readAccountCurrency(accountId: string): Promise<string> {
  const digits = metaAccountDigits(accountId);
  if (!digits) throw new Error("Compte Meta invalide");
  const raw = await metaGraphGetOnce<{ currency?: string }>(`/act_${digits}`, getMetaSystemToken(), { fields: "currency" });
  if (typeof raw?.currency !== "string" || !/^[A-Z]{3}$/.test(raw.currency)) throw new Error("Devise du compte illisible");
  return raw.currency;
}

export type WriteOutcome =
  | { kind: "done" }
  | { kind: "refused"; error: string }
  | { kind: "uncertain"; error: string };

/** What a Pilotage field writes on Meta: one Graph field, or the strategy and its cap together. */
export function metaFieldsFor(field: string, value: string | number): Record<string, string> | null {
  switch (field) {
    case "cost_cap": return { bid_strategy: "COST_CAP", bid_amount: String(value) };
    case "roas_floor": return { bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", bid_constraints: JSON.stringify({ roas_average_floor: Math.round(Number(value) * 10000) }) };
    case "bid_strategy": return { bid_strategy: String(value) };
    case "status": case "daily_budget": case "lifetime_budget": case "bid_amount": case "end_time": case "stop_time": case "start_time": case "name": case "spend_cap": case "targeting":
      return { [field]: String(value) };
    case "creative": return { creative: JSON.stringify({ creative_id: String(value) }) };
    default: return null;
  }
}

/** One field written on one object. Never throws: the outcome says what happened. */
export async function writeField(guard: WriteGuard, objectId: string, field: string, value: string | number): Promise<WriteOutcome> {
  try {
    const fields = metaFieldsFor(field, value);
    if (!fields) return { kind: "refused", error: "Ce changement ne peut pas être envoyé à Meta depuis ImpulseMotion." };
    const keys = Object.keys(fields);
    if (keys.length === 1) await metaGraphUpdate(guard, objectId, keys[0], fields[keys[0]], getMetaSystemToken());
    else await metaGraphUpdateFields(guard, objectId, fields, getMetaSystemToken());
    return { kind: "done" };
  } catch (e) {
    if (isMetaWriteUncertain(e)) return { kind: "uncertain", error: "Meta n'a pas répondu à temps : la modification a peut-être été appliquée. Vérifiez dans le Gestionnaire de publicités avant de recommencer." };
    const message = (e instanceof Error ? e.message : String(e)).replace(/access_token=[^\s&"']+/gi, "access_token=[masqué]");
    return { kind: "refused", error: `Refusé par Meta : ${String(message).slice(0, 300)}` };
  }
}

/**
 * A copy of a campaign, an ad set or an ad: everything below it too, PAUSED,
 * renamed with the suffix that makes the name asked. Never throws.
 */
export async function copyObject(guard: WriteGuard, objectId: string, type: PilotObjectType, currentName: string, newName: string): Promise<WriteOutcome & { copiedId?: string }> {
  // Meta renames by suffix only: the suffix is what the new name adds after the current one, else the whole name after a separator.
  const suffix = newName.startsWith(currentName) && newName.length > currentName.length ? newName.slice(currentName.length) : ` — ${newName}`;
  const fields: Record<string, string> = {
    deep_copy: type === "ad" ? "false" : "true",
    status_option: "PAUSED",
    rename_options: JSON.stringify({ rename_strategy: "ONLY_TOP_LEVEL_RENAME", rename_suffix: suffix.slice(0, 80).replace(/["\\]/g, "") }),
  };
  try {
    const res = await metaGraphCopy(guard, objectId, fields, getMetaSystemToken());
    const copiedId = res.copied_campaign_id ?? res.copied_adset_id ?? res.copied_ad_id ?? res.ad_object_ids?.find((o) => o.source_id === objectId)?.copied_id ?? null;
    if (!copiedId || !/^\d{5,25}$/.test(String(copiedId))) return { kind: "uncertain", error: "Meta a répondu sans identifiant de copie : vérifiez dans le Gestionnaire de publicités avant de recommencer." };
    return { kind: "done", copiedId: String(copiedId) };
  } catch (e) {
    if (isMetaWriteUncertain(e)) return { kind: "uncertain", error: "Meta n'a pas répondu à temps : la copie a peut-être été créée. Vérifiez dans le Gestionnaire de publicités avant de recommencer." };
    const message = (e instanceof Error ? e.message : String(e)).replace(/access_token=[^\s&"']+/gi, "access_token=[masqué]");
    return { kind: "refused", error: `Refusé par Meta : ${String(message).slice(0, 300)}` };
  }
}

/** The custom audiences of the account (for the targeting editor): id, name, kind, size, usable or not. */
export async function readCustomAudiences(accountId: string): Promise<Array<{ id: string; name: string; subtype: string; size: number | null; ready: boolean }>> {
  const digits = metaAccountDigits(accountId);
  if (!digits) throw new Error("Compte Meta invalide");
  const res = await metaGraphGetAll<{ id: string; name?: string; subtype?: string; approximate_count_lower_bound?: number; delivery_status?: { code?: number } }>(
    `/act_${digits}/customaudiences`, getMetaSystemToken(), { fields: "id,name,subtype,approximate_count_lower_bound,delivery_status", limit: "200" }, 1000,
  );
  return res.data.map((a) => ({
    id: String(a.id), name: String(a.name ?? a.id), subtype: String(a.subtype ?? ""),
    size: typeof a.approximate_count_lower_bound === "number" && a.approximate_count_lower_bound >= 0 ? a.approximate_count_lower_bound : null,
    ready: a.delivery_status?.code === 200 || a.delivery_status === undefined,
  })).sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

/** The creative an ad shows now, with everything the new one keeps; null when the ad is not an image/video link ad. */
export async function readAdCreative(adId: string): Promise<{ adName: string; accountId: string; creative: MetaAdCreative | null } | null> {
  if (!/^\d{5,25}$/.test(adId)) throw new Error("Annonce invalide");
  const raw = await metaGraphGetOnce<Raw>(`/${adId}`, getMetaSystemToken(), { fields: "id,account_id,name,creative{id,name,object_story_spec}" });
  if (!raw?.id) return null;
  return { adName: String(raw.name ?? ""), accountId: metaAccountDigits(raw.account_id) ?? "", creative: readMetaCreative(raw.creative as Parameters<typeof readMetaCreative>[0]) };
}

/**
 * A new creative with the texts asked (same Page, image or video, link), then
 * the ad switched to it. Never throws; `creativeId` when the creative exists
 * (the switch may still have failed: said in the outcome).
 */
export async function rewriteAdTexts(guard: WriteGuard, accountId: string, adId: string, texts: MetaAdTexts): Promise<WriteOutcome & { creativeId?: string }> {
  const read = await readAdCreative(adId).catch(() => null);
  if (!read || read.accountId !== accountId) return { kind: "refused", error: "Annonce introuvable sur Meta : rien n'a été envoyé." };
  if (!read.creative) return { kind: "refused", error: "Cette annonce n'est pas une annonce image ou vidéo avec un lien : ses textes se changent dans le Gestionnaire de publicités." };
  const story = metaStoryWithTexts(read.creative, { ...texts, kind: read.creative.kind });
  let creativeId: string;
  try {
    const res = await metaGraphPost<{ id?: string }>(guard, { kind: "adcreative", accountId }, getMetaSystemToken(), {
      name: `${read.creative.creativeName || read.adName} — ${new Date().toISOString().slice(0, 10)}`.slice(0, 255),
      object_story_spec: JSON.stringify(story),
    });
    creativeId = String(res?.id ?? "");
  } catch (e) {
    if (isMetaWriteUncertain(e)) return { kind: "uncertain", error: "Meta n'a pas répondu à temps : la nouvelle créa a peut-être été créée (l'annonce n'a pas changé). Vérifiez dans le Gestionnaire avant de recommencer." };
    return { kind: "refused", error: `Refusé par Meta (création de la créa) : ${(e instanceof Error ? e.message : String(e)).replace(/access_token=[^\s&"']+/gi, "access_token=[masqué]").slice(0, 300)}` };
  }
  if (!/^\d{5,25}$/.test(creativeId)) return { kind: "uncertain", error: "Meta a répondu sans identifiant de créa : vérifiez dans le Gestionnaire de publicités avant de recommencer." };
  const switched = await writeField(guard, adId, "creative", creativeId);
  if (switched.kind !== "done") return { ...switched, creativeId, error: `${switched.error} (la nouvelle créa ${creativeId} existe, l'annonce montre encore l'ancienne)` };
  return { kind: "done", creativeId };
}
