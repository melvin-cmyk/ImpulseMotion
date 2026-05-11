import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { getAccountInsights, getMetaSystemToken, getActionValue } from "@/lib/meta-api";

export const maxDuration = 60;

interface PortfolioClient {
  userId: string;
  email: string | null;
  name: string | null;
  accounts: Array<{
    accountId: string;
    label: string | null;
    platform: string;
    spend: number;
    roas: number;
    ctr: number;
    frequency: number;
    fetchOk: boolean;
  }>;
  totalSpend: number;
  avgRoas: number;
  alertCount: number;
}

export async function GET() {
  const guard = await requireAdmin();
  if ("error" in guard) return guard.error;

  const users = await prisma.user.findMany({
    where: { role: "client" },
    select: {
      id: true,
      email: true,
      name: true,
      adAccounts: { select: { platform: true, accountId: true, label: true } },
    },
  });

  // Past 30 days for the global portfolio overview
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const range = { since: fmt(since), until: fmt(until) };

  const token = getMetaSystemToken();

  // Count open alerts per user in one query
  const openAlertsRaw = await prisma.alertEvent.groupBy({
    by: ["userId"],
    where: { acknowledged: false },
    _count: true,
  });
  const alertCountByUser = new Map(openAlertsRaw.map((r) => [r.userId, r._count]));

  const clients: PortfolioClient[] = await Promise.all(
    users.map(async (user) => {
      const accounts = await Promise.all(
        user.adAccounts
          .filter((a) => a.platform === "meta")
          .map(async (a) => {
            const insight = await getAccountInsights(token, a.accountId, range);
            const spend = parseFloat(insight?.spend ?? "0");
            const purchaseValue = getActionValue(insight?.actions, "purchase") * 20;
            const roas = spend > 0 ? Math.round((purchaseValue / spend) * 100) / 100 : 0;
            const ctr = parseFloat(insight?.ctr ?? "0");
            const frequency = parseFloat(insight?.frequency ?? "0");
            return {
              accountId: a.accountId,
              label: a.label,
              platform: a.platform,
              spend: Math.round(spend),
              roas,
              ctr,
              frequency,
              fetchOk: !!insight,
            };
          }),
      );

      const totalSpend = accounts.reduce((s, a) => s + a.spend, 0);
      const roasAccounts = accounts.filter((a) => a.roas > 0);
      const avgRoas = roasAccounts.length > 0
        ? Math.round((roasAccounts.reduce((s, a) => s + a.roas, 0) / roasAccounts.length) * 100) / 100
        : 0;

      return {
        userId: user.id,
        email: user.email,
        name: user.name,
        accounts,
        totalSpend,
        avgRoas,
        alertCount: alertCountByUser.get(user.id) ?? 0,
      };
    }),
  );

  // Sort by total spend desc
  clients.sort((a, b) => b.totalSpend - a.totalSpend);

  const summary = {
    clientCount: clients.length,
    totalSpend: clients.reduce((s, c) => s + c.totalSpend, 0),
    openAlerts: openAlertsRaw.reduce((s, r) => s + r._count, 0),
    range,
  };

  return NextResponse.json({ clients, summary });
}
