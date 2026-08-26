import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { getMetaSystemToken, computeRevenue } from "@/lib/meta-api";
import { getAccountInsightsCached } from "@/lib/insights";
import { getAovMap, aovFor } from "@/lib/account-settings";
import { computePacingBatch } from "@/lib/budgets";

export const maxDuration = 60;

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const isAdmin = guard.session.role === "admin";

  // For admin: aggregate over ALL client users.
  // For non-admin (client / consultant): only over their own UserAdAccount rows.
  const users = isAdmin
    ? await prisma.user.findMany({
        where: { role: "client" },
        select: {
          id: true,
          email: true,
          name: true,
          adAccounts: { select: { platform: true, accountId: true, label: true } },
        },
      })
    : await prisma.user.findMany({
        where: { id: guard.session.userId },
        select: {
          id: true,
          email: true,
          name: true,
          adAccounts: { select: { platform: true, accountId: true, label: true } },
        },
      });

  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const range = { since: fmt(since), until: fmt(until) };
  const token = getMetaSystemToken();

  // Alert events scoped to the viewer
  const eventsWhere = isAdmin ? {} : { userId: guard.session.userId };
  const openAlerts = await prisma.alertEvent.findMany({
    where: { ...eventsWhere, acknowledged: false },
    orderBy: { triggeredAt: "desc" },
    take: 20,
    select: {
      id: true,
      ruleId: true,
      userId: true,
      clientId: true,
      metric: true,
      value: true,
      threshold: true,
      message: true,
      acknowledged: true,
      triggeredAt: true,
      recommendations: true,
      rule: { select: { metric: true, condition: true, threshold: true, window: true } },
    },
  });

  // Recent reports scoped to the viewer
  const reportsWhere = isAdmin ? {} : { userId: guard.session.userId };
  const recentReports = await prisma.deckHistory.findMany({
    where: reportsWhere,
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      clientId: true,
      clientName: true,
      platform: true,
      period: true,
      startDate: true,
      endDate: true,
      createdAt: true,
    },
  });

  const allMetaAccountIds = users.flatMap((u) =>
    u.adAccounts.filter((a) => a.platform === "meta").map((a) => a.accountId),
  );
  const aovMap = await getAovMap("meta", allMetaAccountIds);

  const clients = await Promise.all(
    users.map(async (user) => {
      const accounts = await Promise.all(
        user.adAccounts
          .filter((a) => a.platform === "meta")
          .map(async (a) => {
            const insight = await getAccountInsightsCached(token, a.accountId, range);
            const spend = parseFloat(insight?.spend ?? "0");
            const revenue = insight ? computeRevenue(insight, aovFor(aovMap, a.accountId)).revenue : 0;
            const roas = spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0;
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

      const alertCount = openAlerts.filter((e) => e.userId === user.id).length;

      return {
        userId: user.id,
        email: user.email,
        name: user.name,
        accounts,
        totalSpend,
        avgRoas,
        alertCount,
      };
    }),
  );

  clients.sort((a, b) => b.totalSpend - a.totalSpend);

  // Flag accounts with open alerts
  const alertedAccountIds = new Set(openAlerts.map((e) => e.clientId));
  const urgentAccounts = clients.flatMap((c) =>
    c.accounts
      .filter((a) => alertedAccountIds.has(a.accountId))
      .map((a) => ({
        ...a,
        clientUserId: c.userId,
        clientLabel: c.name ?? c.email,
      })),
  );

  const summary = {
    clientCount: clients.length,
    accountCount: clients.reduce((s, c) => s + c.accounts.length, 0),
    totalSpend: clients.reduce((s, c) => s + c.totalSpend, 0),
    openAlerts: openAlerts.length,
    urgentAccountCount: urgentAccounts.length,
    range,
    isAdmin,
  };

  // Budget pacing — admin sees everyone's, client/consultant sees their own.
  const budgetsWhere = isAdmin ? {} : { userId: guard.session.userId };
  const budgets = await prisma.accountBudget.findMany({
    where: budgetsWhere,
    orderBy: { updatedAt: "desc" },
  });
  const pacing = await computePacingBatch(
    budgets.map((b) => ({ accountId: b.accountId, monthlyTarget: b.monthlyTarget, currency: b.currency })),
  );
  const pacingByAccount = new Map(pacing.map((p) => [p.accountId, p]));

  const pacingItems = budgets.map((b) => ({
    id: b.id,
    accountId: b.accountId,
    monthlyTarget: b.monthlyTarget,
    currency: b.currency,
    pacing: pacingByAccount.get(b.accountId) ?? null,
  }));

  return NextResponse.json({
    summary,
    clients,
    alerts: openAlerts,
    recentReports,
    urgentAccounts,
    pacing: pacingItems,
  });
}
