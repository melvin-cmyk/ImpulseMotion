/**
 * Account scope — the single answer to "which clients may this session see?".
 *
 *   admin       → everything (BM-wide).
 *   consultant  → only the ad accounts an admin assigned in UserAdAccount.
 *   client      → same rule (their own accounts), plus dashboard membership
 *                 handled separately in lib/dashboard-auth.
 *
 * A client (= a dashboard) is in scope when at least one of its ad accounts
 * (Meta, Google, or a TikTok advertiser attached as a DashboardSource) is assigned. Dashboards with no account attached are only
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

export function tiktokInScope(scope: AccountScope, advertiserId: string | null | undefined): boolean {
  if (scope.all) return true;
  return !!advertiserId && scope.tiktok.has(advertiserId.trim());
}

/** True when an ad account id — Meta, Google or TikTok, platform unknown — is assigned.
 *  Used where a row stores a bare account id (alert rules & events). */
export function accountIdInScope(scope: AccountScope, accountId: string | null | undefined): boolean {
  if (scope.all) return true;
  return metaInScope(scope, accountId) || googleInScope(scope, accountId) || tiktokInScope(scope, accountId);
}

/** The same question when the platform is known (alerts, cockpit, routines). */
export function platformAccountInScope(scope: AccountScope, platform: string, accountId: string | null | undefined): boolean {
  if (scope.all) return true;
  if (platform === "meta") return metaInScope(scope, accountId);
  if (platform === "google") return googleInScope(scope, accountId);
  if (platform === "tiktok") return tiktokInScope(scope, accountId);
  return false;
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
  binding: { metaAccountId?: string | null; googleCustomerId?: string | null; tiktokAdvertiserIds?: string[] | null },
): string | null {
  if (scope.all) return null;
  if (binding.metaAccountId && !metaInScope(scope, binding.metaAccountId)) return binding.metaAccountId;
  if (binding.googleCustomerId && !googleInScope(scope, binding.googleCustomerId)) return binding.googleCustomerId;
  for (const id of binding.tiktokAdvertiserIds ?? []) if (!tiktokInScope(scope, id)) return id;
  return null;
}

/**
 * The ad accounts of a dashboard. TikTok advertisers live in DashboardSource
 * (kind "tiktok"): pass them when the caller loaded them (`TIKTOK_SOURCES_SELECT`),
 * otherwise only Meta and Google decide.
 */
export type DashboardAccounts = {
  metaAccountId: string | null;
  googleCustomerId: string | null;
  sources?: Array<{ kind: string; externalId: string; status?: string | null }>;
};

/** Prisma `select` of the TikTok advertisers of a dashboard, for dashboardInScope. */
export const TIKTOK_SOURCES_SELECT = {
  where: { kind: "tiktok", status: { not: "disabled" } },
  select: { kind: true, externalId: true, status: true },
} satisfies Prisma.Dashboard$sourcesArgs;

/** TikTok advertiser ids of a dashboard, from its loaded sources. */
export function dashboardTikTokIds(d: Pick<DashboardAccounts, "sources">): string[] {
  return (d.sources ?? []).filter((s) => s.kind === "tiktok" && s.status !== "disabled").map((s) => s.externalId);
}

/** A client is visible when one of its ad accounts is assigned to the viewer. */
export function dashboardInScope(scope: AccountScope, d: DashboardAccounts): boolean {
  if (scope.all) return true;
  return metaInScope(scope, d.metaAccountId) || googleInScope(scope, d.googleCustomerId)
    || dashboardTikTokIds(d).some((id) => tiktokInScope(scope, id));
}

/** Prisma filter equivalent of dashboardInScope (for list queries). */
export function dashboardWhere(scope: AccountScope): Prisma.DashboardWhereInput {
  if (scope.all) return {};
  const metaIds = [...scope.meta].flatMap((id) => [id, `act_${id}`]);
  const googleIds = [...scope.google];
  const tiktokIds = [...scope.tiktok];
  const or: Prisma.DashboardWhereInput[] = [];
  if (metaIds.length) or.push({ metaAccountId: { in: metaIds } });
  if (googleIds.length) or.push({ googleCustomerId: { in: googleIds } });
  if (tiktokIds.length) or.push({ sources: { some: { kind: "tiktok", externalId: { in: tiktokIds }, status: { not: "disabled" } } } });
  // Nothing assigned → match nothing (an impossible id keeps the query valid).
  return or.length ? { OR: or } : { id: "__none__" };
}

/** Loads the accounts of a dashboard and tells whether the viewer may see it. */
export async function dashboardIdInScope(scope: AccountScope, dashboardId: string): Promise<boolean> {
  if (scope.all) return true;
  const d = await prisma.dashboard.findUnique({
    where: { id: dashboardId },
    select: { metaAccountId: true, googleCustomerId: true, sources: TIKTOK_SOURCES_SELECT },
  });
  return !!d && dashboardInScope(scope, d);
}

/** Same check through a report (report → dashboard). Missing report → false. */
export async function reportIdInScope(scope: AccountScope, reportId: string): Promise<boolean> {
  if (scope.all) return true;
  const r = await prisma.clientReport.findUnique({
    where: { id: reportId },
    select: { dashboard: { select: { metaAccountId: true, googleCustomerId: true, sources: TIKTOK_SOURCES_SELECT } } },
  });
  return !!r && dashboardInScope(scope, r.dashboard);
}
