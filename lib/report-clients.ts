/**
 * Clients a consultant may write a report on although nobody created their
 * dashboard yet: the ad accounts an admin assigned to them that no dashboard
 * covers. The dashboard — a report hangs on one — is created when the first
 * report is asked for (app/api/reports/route.ts).
 *
 * Admins see every account of the agency: for them the list would be the
 * whole agency, so it only exists for a consultant's own accounts.
 */

import { prisma } from "@/lib/prisma";
import { normGoogle, normMeta } from "@/lib/portfolio";
import type { AccountScope } from "@/lib/scope";
import { looksLikeId, parseAccounts } from "@/lib/auto-alerts/clients";

export interface PendingClient {
  /** "account:meta=<id>,google=<id>" — either part may be missing. */
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
}

const PENDING_RE = /^account:(?:meta=(\d{3,30}))?,?(?:google=(\d{3,30}))?$/;

export function pendingId(meta: string | null, google: string | null): string {
  return `account:${[meta ? `meta=${meta}` : "", google ? `google=${google}` : ""].filter(Boolean).join(",")}`;
}

/** Accounts named by a pending id; null when it is not one. */
export function parsePendingId(id: string): { metaAccountId: string | null; googleCustomerId: string | null } | null {
  const m = PENDING_RE.exec(id);
  if (!m || (!m[1] && !m[2])) return null;
  return { metaAccountId: m[1] ?? null, googleCustomerId: m[2] ?? null };
}

export interface PendingInput {
  scope: { meta: string[]; google: string[] };
  /** Accounts a dashboard already covers. */
  covered: { meta: Set<string>; google: Set<string> };
  /** Name the admin gave when assigning the account. */
  labels: Map<string, string>;
  /** Groups of accounts that are one client, with its name (automatic alerting). */
  groups: Array<{ name: string; accounts: Array<{ platform: string; accountId: string; name: string }> }>;
}

/** Pure: one entry per client, Meta and Google side by side when they are the same client. */
export function buildPending(input: PendingInput): PendingClient[] {
  const free = {
    meta: input.scope.meta.map(normMeta).filter((id) => id && !input.covered.meta.has(id)),
    google: input.scope.google.map(normGoogle).filter((id) => id && !input.covered.google.has(id)),
  };
  const groupOf = new Map<string, number>();
  const accountName = new Map<string, string>();
  input.groups.forEach((g, i) => g.accounts.forEach((a) => {
    groupOf.set(`${a.platform}:${a.accountId}`, i);
    accountName.set(`${a.platform}:${a.accountId}`, a.name);
  }));

  const out: PendingClient[] = [];
  const used = new Set<string>();
  const nameOf = (keys: string[], group: number | undefined): string => {
    const named = [
      ...keys.map((k) => input.labels.get(k)),
      group !== undefined ? input.groups[group].name : undefined,
      ...keys.map((k) => accountName.get(k)),
    ].find((n) => n && !looksLikeId(n));
    return named ?? `Compte ${keys[0].split(":")[1]}`;
  };
  for (const id of free.meta) {
    const key = `meta:${id}`;
    const group = groupOf.get(key);
    // The Google account of the same client, when the consultant has it too.
    const google = group === undefined ? undefined : free.google.find((g) => groupOf.get(`google:${g}`) === group && !used.has(`google:${g}`));
    used.add(key);
    if (google) used.add(`google:${google}`);
    out.push({ id: pendingId(id, google ?? null), name: nameOf(google ? [key, `google:${google}`] : [key], group), metaAccountId: id, googleCustomerId: google ?? null });
  }
  for (const id of free.google) {
    const key = `google:${id}`;
    if (used.has(key)) continue;
    out.push({ id: pendingId(null, id), name: nameOf([key], groupOf.get(key)), metaAccountId: null, googleCustomerId: id });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

export async function pendingReportClients(userId: string, scope: AccountScope): Promise<PendingClient[]> {
  if (scope.all || (!scope.meta.size && !scope.google.size)) return [];
  const [boards, mine, alertClients] = await Promise.all([
    prisma.dashboard.findMany({ select: { metaAccountId: true, googleCustomerId: true } }),
    prisma.userAdAccount.findMany({ where: { userId }, select: { platform: true, accountId: true, label: true } }),
    prisma.alertClient.findMany({ where: { gone: false }, select: { name: true, accountsJson: true } }).catch(() => []),
  ]);
  const labels = new Map<string, string>();
  for (const a of mine) {
    if (!a.label) continue;
    labels.set(`${a.platform}:${a.platform === "meta" ? normMeta(a.accountId) : normGoogle(a.accountId)}`, a.label);
  }
  return buildPending({
    scope: { meta: [...scope.meta], google: [...scope.google] },
    covered: {
      meta: new Set(boards.map((b) => (b.metaAccountId ? normMeta(b.metaAccountId) : "")).filter(Boolean)),
      google: new Set(boards.map((b) => (b.googleCustomerId ? normGoogle(b.googleCustomerId) : "")).filter(Boolean)),
    },
    labels,
    groups: alertClients.map((c) => ({ name: c.name, accounts: parseAccounts(c.accountsJson) })),
  });
}
