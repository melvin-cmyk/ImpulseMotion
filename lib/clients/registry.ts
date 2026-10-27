/**
 * The agency's client registry — ONE row per client with every ad account
 * (Meta, Google, TikTok) under it, the way the team thinks ("Cours Legendre"
 * = its Meta account + its three Google customers), with or without a
 * dashboard.
 *
 * Source: AlertClient (lib/auto-alerts/clients.ts builds and refreshes it
 * daily from the budget sheet, the accounts the agency can read and the
 * dashboards), enriched with the dashboards attached to its accounts (cockpit,
 * reports, Drive folder, HQ brief). A client without any dashboard (e.g. a
 * Google-only account) is still listed: Analyse Ads reads the warehouse
 * directly; the cockpit offers to create its dashboard.
 */

import { prisma } from "@/lib/prisma";
import { clientInScope, parseAlertAccounts, type AlertAccount } from "@/lib/auto-alerts/clients";
import { dashboardWhere, type AccountScope } from "@/lib/scope";
import { TIKTOK_ACCOUNT_SOURCES_SELECT } from "@/lib/tiktok-dashboard";

export interface ClientAccountRef { platform: "meta" | "google" | "tiktok"; id: string; name: string }

export interface ClientRef {
  /** Stable id used by the app: the primary dashboard id when the client has one, else the registry id. */
  id: string;
  /** Registry id (AlertClient) — the client itself, independent of dashboards. */
  clientId: string;
  /** Other registry ids merged into this client (same name): still accepted as its id. */
  aliasIds: string[];
  name: string;
  /** Every ad account of the client, all platforms. */
  accounts: ClientAccountRef[];
  /** Primary dashboard (oldest) and every dashboard attached to one of its accounts. */
  dashboardId: string | null;
  dashboardIds: string[];
  /** Compatibility with the surfaces that expect one account per platform (first of each). */
  metaAccountId: string | null;
  googleCustomerId: string | null;
  tiktokAdvertiserIds: string[];
  driveFolderId: string | null;
  hqSlug: string | null;
}

const normMeta = (id: string) => id.replace(/^act_/, "");
const normGoogle = (id: string) => id.replace(/-/g, "");

export async function listClientRegistry(scope: AccountScope): Promise<ClientRef[]> {
  const [clients, dashboards] = await Promise.all([
    prisma.alertClient.findMany({ select: { id: true, name: true, accountsJson: true, dashboardId: true }, orderBy: { name: "asc" } }),
    prisma.dashboard.findMany({ where: dashboardWhere(scope), select: { id: true, name: true, metaAccountId: true, googleCustomerId: true, driveFolderId: true, hqSlug: true, createdAt: true, sources: TIKTOK_ACCOUNT_SOURCES_SELECT }, orderBy: { createdAt: "asc" } }),
  ]);
  // Index dashboards by account.
  const byAccount = new Map<string, typeof dashboards>();
  const push = (k: string, d: (typeof dashboards)[number]) => { const l = byAccount.get(k) ?? []; l.push(d); byAccount.set(k, l); };
  for (const d of dashboards) {
    if (d.metaAccountId) push(`meta:${normMeta(d.metaAccountId)}`, d);
    if (d.googleCustomerId) push(`google:${normGoogle(d.googleCustomerId)}`, d);
    for (const s of d.sources ?? []) if (s.kind === "tiktok" && s.status !== "disabled") push(`tiktok:${s.externalId}`, d);
  }
  const claimed = new Set<string>();
  const out: ClientRef[] = [];
  for (const c of clients) {
    const accounts: AlertAccount[] = parseAlertAccounts(c.accountsJson);
    if (!accounts.length || !clientInScope(scope, accounts)) continue;
    const accs: ClientAccountRef[] = accounts.map((a) => ({ platform: a.platform as ClientAccountRef["platform"], id: a.platform === "meta" ? normMeta(a.accountId) : a.platform === "google" ? normGoogle(a.accountId) : a.accountId, name: a.name }));
    const linked = new Map<string, (typeof dashboards)[number]>();
    for (const a of accs) for (const d of byAccount.get(`${a.platform}:${a.id}`) ?? []) linked.set(d.id, d);
    const ds = Array.from(linked.values()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const d of ds) claimed.add(d.id);
    const primary = ds.find((d) => d.id === c.dashboardId) ?? ds[0] ?? null;
    out.push({
      id: primary?.id ?? `c_${c.id}`,
      clientId: c.id,
      aliasIds: [],
      name: c.name,
      accounts: accs,
      dashboardId: primary?.id ?? null,
      dashboardIds: ds.map((d) => d.id),
      metaAccountId: accs.find((a) => a.platform === "meta")?.id ?? null,
      googleCustomerId: accs.find((a) => a.platform === "google")?.id ?? null,
      tiktokAdvertiserIds: accs.filter((a) => a.platform === "tiktok").map((a) => a.id),
      driveFolderId: ds.map((d) => d.driveFolderId).find(Boolean) ?? null,
      hqSlug: ds.map((d) => d.hqSlug).find(Boolean) ?? null,
    });
  }
  // Dashboards the registry does not know (e.g. an account added today): one client each, so nothing disappears.
  for (const d of dashboards) {
    if (claimed.has(d.id)) continue;
    const accs: ClientAccountRef[] = [];
    if (d.metaAccountId) accs.push({ platform: "meta", id: normMeta(d.metaAccountId), name: d.name });
    if (d.googleCustomerId) accs.push({ platform: "google", id: normGoogle(d.googleCustomerId), name: d.name });
    for (const s of d.sources ?? []) if (s.kind === "tiktok" && s.status !== "disabled") accs.push({ platform: "tiktok", id: s.externalId, name: d.name });
    if (!accs.length) continue;
    claimed.add(d.id);
    out.push({ id: d.id, clientId: `d_${d.id}`, aliasIds: [], name: d.name, accounts: accs, dashboardId: d.id, dashboardIds: [d.id], metaAccountId: accs.find((a) => a.platform === "meta")?.id ?? null, googleCustomerId: accs.find((a) => a.platform === "google")?.id ?? null, tiktokAdvertiserIds: accs.filter((a) => a.platform === "tiktok").map((a) => a.id), driveFolderId: d.driveFolderId, hqSlug: d.hqSlug });
  }
  return mergeSameName(out).sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

const nameKey = (n: string) => n.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Same name = same brand: the budget sheet and the account listings sometimes
 * yield two registry rows for one client ("Le Barth Villas" twice). They are
 * merged at read time — union of accounts and dashboards, the row with a
 * dashboard (else the first) lends its ids, the others become aliases.
 */
export function mergeSameName(clients: ClientRef[]): ClientRef[] {
  const groups = new Map<string, ClientRef[]>();
  for (const c of clients) { const k = nameKey(c.name); const l = groups.get(k) ?? []; l.push(c); groups.set(k, l); }
  const out: ClientRef[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) { out.push(list[0]); continue; }
    const lead = list.find((c) => c.dashboardId) ?? list[0];
    const seen = new Set<string>();
    const accounts = list.flatMap((c) => c.accounts).filter((a) => { const k = `${a.platform}:${a.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const dashboardIds = Array.from(new Set(list.flatMap((c) => c.dashboardIds)));
    out.push({
      ...lead,
      aliasIds: list.filter((c) => c !== lead).flatMap((c) => [c.clientId, c.id, ...c.aliasIds]),
      accounts,
      dashboardIds,
      metaAccountId: accounts.find((a) => a.platform === "meta")?.id ?? null,
      googleCustomerId: accounts.find((a) => a.platform === "google")?.id ?? null,
      tiktokAdvertiserIds: accounts.filter((a) => a.platform === "tiktok").map((a) => a.id),
      driveFolderId: list.map((c) => c.driveFolderId).find(Boolean) ?? null,
      hqSlug: list.map((c) => c.hqSlug).find(Boolean) ?? null,
    });
  }
  return out;
}

/** One client by app id (dashboard id or c_<registry id>) or by registry id, within the scope. */
export async function findClient(scope: AccountScope, idOrClientId: string): Promise<ClientRef | null> {
  const all = await listClientRegistry(scope);
  return all.find((c) => c.id === idOrClientId || c.clientId === idOrClientId || c.aliasIds.includes(idOrClientId) || c.dashboardIds.includes(idOrClientId)) ?? null;
}
