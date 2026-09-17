/**
 * Account scope — the single answer to "which clients may this session see?".
 *
 *   admin       → everything (BM-wide).
 *   consultant  → only the ad accounts an admin assigned in UserAdAccount.
 *   client      → same rule (their own accounts), plus dashboard membership
 *                 handled separately in lib/dashboard-auth.
 *
 * A client (= a dashboard) is in scope when at least one of its ad accounts
 * (Meta or Google) is assigned. Dashboards with no account attached are only
 * visible to admins. Every staff-facing API (portfolio, cockpit, reports,
 * dashboards, changes, account picker) must go through this module so the
 * admin's ACL is enforced in one place.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type AccountScope =
  | { all: true }
  | { all: false; meta: Set<string>; google: Set<string>; tiktok: Set<string> };

export const ALL_ACCOUNTS: AccountScope = { all: true };

const normMeta = (id: string) => id.replace(/^act_/, "");

type SessionLike = { userId: string; role?: string | null };

export async function getAccountScope(session: SessionLike): Promise<AccountScope> {
  if (session.role === "admin") return ALL_ACCOUNTS;
  const rows = await prisma.userAdAccount.findMany({
    where: { userId: session.userId },
    select: { platform: true, accountId: true },
  });
  const scope = { all: false as const, meta: new Set<string>(), google: new Set<string>(), tiktok: new Set<string>() };
  for (const r of rows) {
    if (r.platform === "meta") scope.meta.add(normMeta(r.accountId));
    else if (r.platform === "google") scope.google.add(r.accountId);
    else if (r.platform === "tiktok") scope.tiktok.add(r.accountId);
  }
  return scope;
}

export function metaInScope(scope: AccountScope, accountId: string | null | undefined): boolean {
  if (scope.all) return true;
  return !!accountId && scope.meta.has(normMeta(accountId));
}

export function googleInScope(scope: AccountScope, customerId: string | null | undefined): boolean {
  if (scope.all) return true;
  return !!customerId && scope.google.has(customerId);
}

/** True when an ad account id — Meta or Google, platform unknown — is assigned.
 *  Used where a row stores a bare account id (alert rules & events). */
export function accountIdInScope(scope: AccountScope, accountId: string | null | undefined): boolean {
  if (scope.all) return true;
  return metaInScope(scope, accountId) || googleInScope(scope, accountId);
}

/**
 * Guards an *incoming* account binding (dashboard creation or re-bind).
 *
 * Binding a dashboard to an account calls grantDashboardAccess, which writes a
 * UserAdAccount row — the very table getAccountScope reads. Without this check a
 * consultant could point a dashboard at any account of the business manager and
 * thereby grant themselves permanent access to that client's data.
 *
 * Returns the offending account id, or null when the binding is allowed.
 */
export function bindingOutOfScope(
  scope: AccountScope,
  binding: { metaAccountId?: string | null; googleCustomerId?: string | null },
): string | null {
  if (scope.all) return null;
  if (binding.metaAccountId && !metaInScope(scope, binding.metaAccountId)) return binding.metaAccountId;
  if (binding.googleCustomerId && !googleInScope(scope, binding.googleCustomerId)) return binding.googleCustomerId;
  return null;
}

export type DashboardAccounts = { metaAccountId: string | null; googleCustomerId: string | null };

/** A client is visible when one of its ad accounts is assigned to the viewer. */
export function dashboardInScope(scope: AccountScope, d: DashboardAccounts): boolean {
  if (scope.all) return true;
  return metaInScope(scope, d.metaAccountId) || googleInScope(scope, d.googleCustomerId);
}

/** Prisma filter equivalent of dashboardInScope (for list queries). */
export function dashboardWhere(scope: AccountScope): Prisma.DashboardWhereInput {
  if (scope.all) return {};
  const metaIds = [...scope.meta].flatMap((id) => [id, `act_${id}`]);
  const googleIds = [...scope.google];
  const or: Prisma.DashboardWhereInput[] = [];
  if (metaIds.length) or.push({ metaAccountId: { in: metaIds } });
  if (googleIds.length) or.push({ googleCustomerId: { in: googleIds } });
  // Nothing assigned → match nothing (an impossible id keeps the query valid).
  return or.length ? { OR: or } : { id: "__none__" };
}

/** Loads the accounts of a dashboard and tells whether the viewer may see it. */
export async function dashboardIdInScope(scope: AccountScope, dashboardId: string): Promise<boolean> {
  if (scope.all) return true;
  const d = await prisma.dashboard.findUnique({
    where: { id: dashboardId },
    select: { metaAccountId: true, googleCustomerId: true },
  });
  return !!d && dashboardInScope(scope, d);
}

/** Same check through a report (report → dashboard). Missing report → false. */
export async function reportIdInScope(scope: AccountScope, reportId: string): Promise<boolean> {
  if (scope.all) return true;
  const r = await prisma.clientReport.findUnique({
    where: { id: reportId },
    select: { dashboard: { select: { metaAccountId: true, googleCustomerId: true } } },
  });
  return !!r && dashboardInScope(scope, r.dashboard);
}
