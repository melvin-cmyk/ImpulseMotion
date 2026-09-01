/**
 * GET /api/changes?accountId=act_…  → events for one Meta account (ACL-checked)
 * GET /api/changes                  → staff: every portfolio client (deduped
 *                                     Meta accounts), ≤ 3 in parallel, capped
 *                                     at 20 clients (`truncated`); clients:
 *                                     their own ACL accounts.
 * ?refresh=1 drops the cached ads/insights lists first.
 */

import { NextRequest, NextResponse } from "next/server";
import { isStaff, requireSession } from "@/lib/auth-helpers";
import { assertAccountAllowed, getAllowedAccountIds } from "@/lib/acl";
import { prisma } from "@/lib/prisma";
import { detectAccountChangesDetailed, type ChangeEvent } from "@/lib/changes";
import { listPortfolioClients } from "@/lib/portfolio";

export const maxDuration = 120;

const MAX_CLIENTS = 20;
const CONCURRENCY = 3;
const TIME_BUDGET_MS = 100_000;

/** Bounded concurrency + global deadline: unfinished tasks are left running (not aborted) and reported. */
async function mapLimitWithDeadline<T, R>(
  items: T[],
  limit: number,
  deadlineAt: number,
  fn: (item: T) => Promise<R>,
): Promise<{ results: Array<R | undefined>; timedOut: boolean }> {
  const results: Array<R | undefined> = new Array(items.length);
  let next = 0;
  let timedOut = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (Date.now() >= deadlineAt) { timedOut = true; return; }
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), Math.max(0, deadlineAt - Date.now())); });
  const outcome = await Promise.race([Promise.all(workers).then(() => "done" as const), clock]);
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") timedOut = true;
  return { results, timedOut };
}

export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId");
  const refresh = searchParams.get("refresh") === "1";
  const headers = { "Cache-Control": "no-store" };
  const startedAt = Date.now();

  // Single-account mode: enforce ACL then return events for that account
  if (accountId) {
    if (!isStaff(guard.session)) {
      const allowed = await assertAccountAllowed(guard.session.userId, "meta", accountId);
      if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const result = await detectAccountChangesDetailed(accountId, null, { refresh });
      return NextResponse.json({ events: result.events, range: result.range, compare: result.compare, truncated: result.truncated, revenueAvailable: result.revenueAvailable }, { headers });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Meta indisponible" }, { status: 502, headers });
    }
  }

  // Multi-account mode
  let accounts: Array<{ accountId: string; label: string | null; clientId: string | null }>;
  if (isStaff(guard.session)) {
    const { clients } = await listPortfolioClients();
    accounts = clients
      .filter((c) => c.metaAccountId)
      .map((c) => ({ accountId: c.metaAccountId as string, label: c.name, clientId: c.id }));
  } else {
    const allowedIds = await getAllowedAccountIds(guard.session.userId, "meta");
    const rows = await prisma.userAdAccount.findMany({
      where: { userId: guard.session.userId, platform: "meta" },
      select: { accountId: true, label: true },
    });
    accounts = rows.filter((r) => allowedIds.includes(r.accountId)).map((r) => ({ ...r, clientId: null }));
  }

  const total = accounts.length;
  const truncated = total > MAX_CLIENTS;
  accounts = accounts.slice(0, MAX_CLIENTS);

  const failures: Array<{ accountId: string; label: string | null; error: string }> = [];
  let creativeSkipped = 0;
  const { results, timedOut } = await mapLimitWithDeadline(accounts, CONCURRENCY, startedAt + TIME_BUDGET_MS, async (a): Promise<ChangeEvent[]> => {
    try {
      const r = await detectAccountChangesDetailed(a.accountId, a.label, { refresh, clientId: a.clientId });
      creativeSkipped += r.creativeSkipped;
      return r.events;
    } catch (e) {
      failures.push({ accountId: a.accountId, label: a.label, error: e instanceof Error ? e.message : String(e) });
      return [];
    }
  });
  const events = results.flatMap((r) => r ?? []);
  const unresolved = accounts.filter((_, i) => results[i] === undefined).map((a) => ({ accountId: a.accountId, label: a.label }));

  return NextResponse.json({
    events,
    accountCount: accounts.length,
    totalAccounts: total,
    truncated,
    failures,
    timedOut,
    unresolved,
    skipped: unresolved.length,
    creativeSkipped,
    durationMs: Date.now() - startedAt,
  }, { headers });
}
