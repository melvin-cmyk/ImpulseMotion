/**
 * Per-account settings (AOV fallback, currency, timezone, conversion event)
 * shared by all users.
 *
 * - AOV is only used when the account doesn't track purchase value — see
 *   computeRevenue in lib/meta-api.ts. It is NEVER defaulted: an unconfigured
 *   AOV means revenue is "unavailable", not "20 €".
 * - currency/timezone come from the Meta account profile (authoritative) and
 *   are persisted into AccountSetting as a fallback for when Meta is down.
 */

import { prisma } from "@/lib/prisma";
import { getMetaSystemToken } from "@/lib/meta-api";
import { getAccountProfileCached } from "@/lib/insights";

function normalizeId(accountId: string): string {
  return accountId.replace(/^act_/, "");
}

/** Sentinel returned by the number-typed helpers when no AOV is configured. */
export const AOV_NOT_CONFIGURED = 0;

/** Map of normalized accountId → AOV for the given accounts (missing = not configured). */
export async function getAovMap(
  platform: string,
  accountIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (accountIds.length === 0) return map;
  const normalized = [...new Set(accountIds.map(normalizeId))];
  try {
    const rows = await prisma.accountSetting.findMany({
      where: {
        platform,
        OR: [
          { accountId: { in: normalized } },
          { accountId: { in: normalized.map((id) => `act_${id}`) } },
        ],
      },
    });
    for (const row of rows) {
      if (row.aov && row.aov > 0) map.set(normalizeId(row.accountId), row.aov);
    }
  } catch {
    // settings unavailable → callers treat AOV as not configured
  }
  return map;
}

/**
 * Configured AOV or AOV_NOT_CONFIGURED (0). Passing 0 to computeRevenue yields
 * `unavailable: true` instead of an invented estimate.
 */
export async function getAccountAov(platform: string, accountId: string): Promise<number> {
  const map = await getAovMap(platform, [accountId]);
  return map.get(normalizeId(accountId)) ?? AOV_NOT_CONFIGURED;
}

export function aovFor(map: Map<string, number>, accountId: string): number {
  return map.get(normalizeId(accountId)) ?? AOV_NOT_CONFIGURED;
}

export interface AccountProfileSettings {
  /** Configured AOV (> 0) or null when not configured. */
  aov: number | null;
  /** ISO 4217 code, null when unknown (Meta unreachable and no row). */
  currency: string | null;
  /** IANA timezone (e.g. Europe/Paris), null when unknown. */
  timezone: string | null;
  /** purchase | lead | complete_registration | custom:<action_type> */
  conversionEvent: string;
}

/**
 * AccountSetting row merged with the Meta account profile. The Meta profile
 * (cached 24 h) is authoritative for currency/timezone; the row is the
 * fallback and is updated (upsert) whenever the profile disagrees or the row
 * lacks a value. Never throws: a Meta failure degrades to the stored values.
 */
export async function getAccountProfileSettings(
  platform: string,
  accountId: string,
): Promise<AccountProfileSettings> {
  const id = normalizeId(accountId);
  let row: { aov: number | null; currency: string | null; timezone: string | null; conversionEvent: string | null } | null = null;
  try {
    row = await prisma.accountSetting.findFirst({
      where: { platform, OR: [{ accountId: id }, { accountId: `act_${id}` }] },
      select: { aov: true, currency: true, timezone: true, conversionEvent: true },
    });
  } catch {
    row = null;
  }

  let currency = row?.currency ?? null;
  let timezone = row?.timezone ?? null;

  if (platform === "meta") {
    try {
      const profile = await getAccountProfileCached(getMetaSystemToken(), id);
      const liveCurrency = profile.currency || null;
      const liveTz = profile.timezone_name || null;
      const changed = (liveCurrency && liveCurrency !== currency) || (liveTz && liveTz !== timezone);
      if (liveCurrency) currency = liveCurrency;
      if (liveTz) timezone = liveTz;
      if (changed) {
        try {
          await prisma.accountSetting.upsert({
            where: { platform_accountId: { platform, accountId: id } },
            create: { platform, accountId: id, currency, timezone },
            update: { ...(liveCurrency ? { currency } : {}), ...(liveTz ? { timezone } : {}) },
          });
        } catch {
          // persisting is best effort
        }
      }
    } catch (err) {
      console.warn(`[account-settings] profile unavailable for ${platform}:${id} — using stored values`, err instanceof Error ? err.message : err);
    }
  }

  return {
    aov: row?.aov && row.aov > 0 ? row.aov : null,
    currency,
    timezone,
    conversionEvent: (row?.conversionEvent ?? "").trim() || "purchase",
  };
}
