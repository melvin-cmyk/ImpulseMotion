/**
 * Per-account settings (AOV fallback, currency) shared by all users.
 * The AOV is only used when the account doesn't track purchase value —
 * see computeRevenue in lib/meta-api.ts.
 */

import { prisma } from "@/lib/prisma";
import { DEFAULT_AOV } from "@/lib/meta-api";

function normalizeId(accountId: string): string {
  return accountId.replace(/^act_/, "");
}

/** Map of normalized accountId → AOV for the given accounts (missing = DEFAULT_AOV). */
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
    // settings unavailable → callers fall back to DEFAULT_AOV
  }
  return map;
}

export async function getAccountAov(platform: string, accountId: string): Promise<number> {
  const map = await getAovMap(platform, [accountId]);
  return map.get(normalizeId(accountId)) ?? DEFAULT_AOV;
}

export function aovFor(map: Map<string, number>, accountId: string): number {
  return map.get(normalizeId(accountId)) ?? DEFAULT_AOV;
}
