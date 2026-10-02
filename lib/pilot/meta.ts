/**
 * Pilotage on Meta: the structure of an account (campaigns, ad sets, ads with
 * their budgets and last 7 days' spend), one object as it is now, and one
 * field written then read back.
 *
 * Every object read for a change carries its `account_id`: an object of
 * another account than the one of the action is refused, whatever the page sent.
 */

import { getMetaSystemToken, metaGraphGetAll, metaGraphGetOnce, metaGraphUpdate, isMetaWriteUncertain } from "@/lib/meta-api";
import { isMetaApiError } from "@/lib/meta-errors";
import { metaAccountDigits } from "@/lib/routines/accounts";
import type { WriteGuard } from "@/lib/routines/types";
import type { PilotObjectState, PilotObjectType } from "@/lib/pilot/ops";

const SPEND_7D = "insights.date_preset(last_7d){spend}";
const LIVE_STATUSES = JSON.stringify([{ field: "effective_status", operator: "NOT_IN", value: ["DELETED", "ARCHIVED"] }]);

const FIELDS: Record<PilotObjectType, string> = {
  campaign: "id,account_id,name,status,effective_status,daily_budget,lifetime_budget,stop_time,bid_strategy",
  adset: "id,account_id,name,status,effective_status,daily_budget,lifetime_budget,end_time,bid_amount,bid_strategy,campaign{name}",
  ad: "id,account_id,name,status,effective_status,adset{name}",
};

type Raw = Record<string, unknown> & {
  id: string; name?: string; status?: string; effective_status?: string; account_id?: string;
  daily_budget?: string; lifetime_budget?: string; stop_time?: string; end_time?: string; bid_amount?: number | string;
  bid_strategy?: string; campaign_id?: string; adset_id?: string;
  campaign?: { name?: string }; adset?: { name?: string };
  insights?: { data?: Array<{ spend?: string }> };
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function toState(raw: Raw, type: PilotObjectType): PilotObjectState {
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
    bidAmount: type === "adset" ? num(raw.bid_amount) : null,
    parentName: type === "adset" ? raw.campaign?.name ?? "" : type === "ad" ? raw.adset?.name ?? "" : "",
  };
}

export interface StructureRow extends PilotObjectState {
  parentId: string | null;
  bidStrategy: string | null;
  spend7d: number;
}

const spendOf = (raw: Raw) => Number(raw.insights?.data?.[0]?.spend ?? 0) || 0;

function row(raw: Raw, type: PilotObjectType, parentId: string | null): StructureRow {
  return { ...toState(raw, type), parentId, bidStrategy: raw.bid_strategy ?? null, spend7d: spendOf(raw) };
}

/** Campaigns and ad sets of the account that are not deleted or archived. */
export async function readStructure(accountId: string): Promise<{ campaigns: StructureRow[]; adsets: StructureRow[]; truncated: boolean }> {
  const digits = metaAccountDigits(accountId);
  if (!digits) throw new Error("Compte Meta invalide");
  const token = getMetaSystemToken();
  const [campaigns, adsets] = await Promise.all([
    metaGraphGetAll<Raw>(`/act_${digits}/campaigns`, token, { fields: `${FIELDS.campaign},${SPEND_7D}`, filtering: LIVE_STATUSES, limit: "200" }, 1000),
    metaGraphGetAll<Raw>(`/act_${digits}/adsets`, token, { fields: `${FIELDS.adset},campaign_id,${SPEND_7D}`, filtering: LIVE_STATUSES, limit: "200" }, 2000),
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
  const ads = await metaGraphGetAll<Raw>(`/${adsetId}/ads`, getMetaSystemToken(), { fields: `${FIELDS.ad},${SPEND_7D}`, filtering: LIVE_STATUSES, limit: "200" }, 500);
  return ads.data.map((r) => row(r, "ad", adsetId));
}

/**
 * One object as Meta holds it now; null only when Meta says it does not exist
 * (code 100, subcode 33). Quota, token or permission errors are thrown: they
 * say nothing of the object.
 */
export async function readObject(objectId: string, type: PilotObjectType): Promise<PilotObjectState | null> {
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

/** One field written on one object. Never throws: the outcome says what happened. */
export async function writeField(guard: WriteGuard, objectId: string, field: string, value: string | number): Promise<WriteOutcome> {
  try {
    await metaGraphUpdate(guard, objectId, field, String(value), getMetaSystemToken());
    return { kind: "done" };
  } catch (e) {
    if (isMetaWriteUncertain(e)) return { kind: "uncertain", error: "Meta n'a pas répondu à temps : la modification a peut-être été appliquée. Vérifiez dans le Gestionnaire de publicités avant de recommencer." };
    const message = (e instanceof Error ? e.message : String(e)).replace(/access_token=[^\s&"']+/gi, "access_token=[masqué]");
    return { kind: "refused", error: `Refusé par Meta : ${String(message).slice(0, 300)}` };
  }
}
