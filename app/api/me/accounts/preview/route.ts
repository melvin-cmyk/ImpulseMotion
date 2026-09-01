import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import {
  getAdAccounts,
  getMetaSystemToken,
  computeRevenue,
} from "@/lib/meta-api";
import { getAccountInsightsCached, getAccountProfileCached } from "@/lib/insights";

async function fetchAccountName(accountId: string, token: string): Promise<{ name: string; currency?: string } | null> {
  // Goes through the Graph limiter/retry (lib/meta-api); cached 24 h.
  try {
    const p = await getAccountProfileCached(token, accountId);
    return { name: p.name, currency: p.currency || undefined };
  } catch (err) {
    console.warn(`[me/accounts/preview] profile unavailable for ${accountId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export const maxDuration = 30;

function offsetDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

interface PreviewAccount {
  id: string;
  name: string;
  currency?: string;
  outOfScope: boolean;
  spend7d: number;
  roas7d: number;
  alertCount: number;
}

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const token = getMetaSystemToken();
  const range = { since: offsetDate(-7), until: offsetDate(0) };

  // Source list — admin sees all BM accounts, others see their ACL'd rows.
  let baseAccounts: Array<{ id: string; name?: string; label?: string | null; currency?: string }>;

  if (guard.session.role === "admin") {
    const all = await getAdAccounts(token).catch(() => []);
    baseAccounts = all.map((a) => ({ id: a.id, name: a.name, currency: a.currency }));
  } else {
    const rows = await prisma.userAdAccount.findMany({
      where: { userId: guard.session.userId, platform: "meta" },
      select: { accountId: true, label: true },
    });
    baseAccounts = rows.map((r) => ({
      id: r.accountId.startsWith("act_") ? r.accountId : `act_${r.accountId}`,
      label: r.label,
    }));
  }

  // Open alert count per accountId for this viewer.
  const eventsWhere = guard.session.role === "admin" ? {} : { userId: guard.session.userId };
  const openAlerts = await prisma.alertEvent.groupBy({
    by: ["clientId"],
    where: { ...eventsWhere, acknowledged: false },
    _count: true,
  });
  const alertByAccount = new Map(openAlerts.map((a) => [a.clientId, a._count]));

  const enriched: PreviewAccount[] = await Promise.all(
    baseAccounts.map(async (a) => {
      const [insight, meta] = await Promise.all([
        getAccountInsightsCached(token, a.id, range).catch(() => null),
        // Only resolve name from Meta if we don't already have it (admin path)
        a.name ? Promise.resolve(null) : fetchAccountName(a.id, token),
      ]);
      const spend = Math.round(parseFloat(insight?.spend ?? "0"));
      const revenue = insight ? computeRevenue(insight).revenue : 0;
      const roas = spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0;

      const idNorm = a.id.replace(/^act_/, "");
      const alertCount =
        alertByAccount.get(a.id) ?? alertByAccount.get(idNorm) ?? alertByAccount.get(`act_${idNorm}`) ?? 0;

      const resolvedName = a.name ?? meta?.name ?? a.label ?? a.id;
      const reachable = !!insight || !!meta;

      return {
        id: a.id,
        name: resolvedName,
        currency: a.currency ?? meta?.currency,
        outOfScope: !reachable,
        spend7d: spend,
        roas7d: roas,
        alertCount,
      };
    }),
  );

  // Sort: alerts first (desc), then spend desc
  enriched.sort((a, b) => {
    if (a.alertCount !== b.alertCount) return b.alertCount - a.alertCount;
    return b.spend7d - a.spend7d;
  });

  return NextResponse.json({ accounts: enriched });
}
