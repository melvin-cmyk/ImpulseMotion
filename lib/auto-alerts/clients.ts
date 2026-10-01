/**
 * Automatic alerting — who is watched.
 *
 * Every ad account the agency can read (Meta system token, Google manager
 * account) is watched, with or without a dashboard. TikTok accounts are
 * watched once they belong to a client: attached to a dashboard
 * (DashboardSource "tiktok") or to a client of the budget sheet
 * (CockpitAccount "tiktok"). Accounts are gathered into clients: the accounts
 * of one client of the budget sheet (same matching as the Global Cockpit),
 * the Meta, Google and TikTok accounts a dashboard puts side by side, and the
 * accounts that bear the same name. An account nobody claims is a client by
 * itself.
 *
 * A client is named after the sheet, else after its account at the platform
 * — what is really scanned — and only then after a dashboard.
 *
 * The list is stored (AlertClient) so that the channel, the settings and the
 * incidents of a client survive a day when a platform cannot be listed.
 */

import { prisma } from "@/lib/prisma";
import { groupDashboardsByAccount, normGoogle, normMeta } from "@/lib/portfolio";
import { platformAccountInScope, type AccountScope } from "@/lib/scope";
import { listGoogleAccounts, listMetaAccounts } from "@/lib/cockpit/fetch";
import { syncAccounts } from "@/lib/cockpit/build";
import { fetchBudgetSheet, sheetClients, type SheetClient } from "@/lib/cockpit/sheet";
import { cockpitCalendar } from "@/lib/cockpit/weeks";
import type { AvailableAccount } from "@/lib/cockpit/match";
import type { AutoPlatform } from "@/lib/auto-alerts/detect";

export interface AlertAccount {
  platform: AutoPlatform;
  accountId: string;
  name: string;
  currency: string | null;
}

/** The Meta and Google accounts only — what the surfaces that do not read TikTok yet get. */
export type ClassicAlertAccount = AlertAccount & { platform: "meta" | "google" };

/** A TikTok account claimed by a client (a dashboard or the budget sheet). */
export interface TikTokCandidate { accountId: string; name: string; currency: string | null }

export interface ClientDraft {
  key: string;
  name: string;
  accounts: AlertAccount[];
  /** Oldest first. */
  dashboardIds: string[];
}

export interface DashboardRow {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  /** TikTok advertisers attached to the dashboard (DashboardSource "tiktok", not disabled). */
  tiktokAdvertiserIds?: string[];
  createdAt: Date | string;
}

export interface BuildInput {
  /** Accounts read at the platforms; an account they do not list is not watched. */
  available: AvailableAccount[];
  /** TikTok accounts a dashboard or the budget sheet claims: no listing of the agency's accounts decides here. */
  tiktok?: TikTokCandidate[];
  /** Account → client of the budget sheet (CockpitAccount). */
  cockpit: Array<{ platform: string; accountId: string; clientKey: string }>;
  /** Name of each client of the sheet. */
  cockpitNames: Map<string, string>;
  dashboards: DashboardRow[];
}

const norm = (platform: AutoPlatform, id: string) => (platform === "meta" ? normMeta(id) : platform === "google" ? normGoogle(id) : id.trim());
const PLATFORM_NAME: Record<AutoPlatform, string> = { meta: "Meta", google: "Google Ads", tiktok: "TikTok Ads" };
const isPlatform = (p: unknown): p is AutoPlatform => p === "meta" || p === "google" || p === "tiktok";
const node = (platform: AutoPlatform, id: string) => `${platform}:${norm(platform, id)}`;
const ts = (d: Date | string) => new Date(d).getTime();

/** « 215903989640516 », « Compte 1543285195886235 », « act_123456 »: an id, not a name. */
export function looksLikeId(name: string | null | undefined): boolean {
  const s = (name ?? "").trim();
  return !s || /^(compte|account|ad account)?\s*(act_)?[\d\s-]{6,}$/i.test(s);
}

const FILLER = /\b(fr|france|ads|adwords|google|meta|facebook|tiktok|new|compte|account|publicitaire|official|officiel|sas|sarl)\b/g;

/** « QUARTIER IODE » = « Quartier Iode », « EcoleMultimedia » = « ECOLE MULTIMEDIA ». Empty when nothing is left. */
export function sameNameKey(name: string): string {
  if (looksLikeId(name)) return "";
  const words = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const key = words.replace(FILLER, " ").replace(/\s+/g, "");
  return key.length >= 4 ? key : "";
}

/** Pure: the clients to watch, given what the platforms, the sheet and the dashboards say. */
export function buildClients(input: BuildInput): ClientDraft[] {
  const accounts = new Map<string, AlertAccount>();
  for (const a of input.available) {
    if (!a.active || !a.accountId) continue;
    accounts.set(node(a.platform, a.accountId), { platform: a.platform, accountId: norm(a.platform, a.accountId), name: a.name, currency: a.currency });
  }
  for (const t of input.tiktok ?? []) {
    const id = norm("tiktok", t.accountId);
    if (!id || accounts.has(node("tiktok", id))) continue;
    accounts.set(node("tiktok", id), { platform: "tiktok", accountId: id, name: t.name, currency: t.currency });
  }
  // An account the agency can no longer read is not watched, even when a
  // dashboard still points to it: there is nothing to check on it, and a
  // message « accès perdu » every time is noise. It comes back by itself the
  // day the platform lists it again.
  const dashboards = [...input.dashboards].sort((a, b) => ts(a.createdAt) - ts(b.createdAt) || a.id.localeCompare(b.id));

  const parent = new Map<string, string>([...accounts.keys()].map((k) => [k, k]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };

  const cockpitOf = new Map<string, string>();
  const firstOfClient = new Map<string, string>();
  for (const c of input.cockpit) {
    if (!isPlatform(c.platform)) continue;
    const k = node(c.platform, c.accountId);
    if (!accounts.has(k)) continue;
    cockpitOf.set(k, c.clientKey);
    const first = firstOfClient.get(c.clientKey);
    if (first) union(first, k); else firstOfClient.set(c.clientKey, k);
  }
  for (const d of dashboards) {
    const m = d.metaAccountId && norm("meta", d.metaAccountId) ? node("meta", d.metaAccountId) : null;
    const g = d.googleCustomerId && norm("google", d.googleCustomerId) ? node("google", d.googleCustomerId) : null;
    const t = (d.tiktokAdvertiserIds ?? []).filter((id) => norm("tiktok", id)).map((id) => node("tiktok", id));
    // Only accounts that are watched link a client: a dashboard does not resurrect an account.
    const linked = [m, g, ...t].filter((k): k is string => !!k && accounts.has(k));
    for (const k of linked.slice(1)) union(linked[0], k);
  }

  const firstOfName = new Map<string, string>();
  for (const [k, a] of accounts) {
    const same = sameNameKey(a.name);
    if (!same) continue;
    const first = firstOfName.get(same);
    if (first) union(first, k); else firstOfName.set(same, k);
  }

  const groups = new Map<string, string[]>();
  for (const k of accounts.keys()) groups.set(find(k), [...(groups.get(find(k)) ?? []), k]);

  const rank = (k: string) => (k.startsWith("tiktok:") ? 2 : k.startsWith("google:") ? 1 : 0);
  const order = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b);
  const out: ClientDraft[] = [];
  for (const members of groups.values()) {
    members.sort(order);
    const mine = members.map((k) => accounts.get(k)!);
    const keys = new Set(members);
    const boards = dashboards.filter((d) =>
      (d.metaAccountId && keys.has(node("meta", d.metaAccountId))) || (d.googleCustomerId && keys.has(node("google", d.googleCustomerId)))
      || (d.tiktokAdvertiserIds ?? []).some((id) => keys.has(node("tiktok", id))));
    const sheetKeys = [...new Set(members.map((k) => cockpitOf.get(k)).filter((k): k is string => !!k))].sort();
    const sheetName = sheetKeys.map((k) => input.cockpitNames.get(k)).find((n) => n && !looksLikeId(n));
    const boardName = boards.map((d) => d.name).find((n) => !looksLikeId(n));
    const accountName = mine.map((a) => a.name).find((n) => !looksLikeId(n));
    const first = mine[0];
    const name = sheetName ?? accountName ?? boardName
      ?? `Compte ${PLATFORM_NAME[first.platform]} ${first.accountId}`;
    out.push({
      key: sheetKeys.length ? `c:${sheetKeys[0]}` : members[0],
      name: name.trim(),
      // An account without a name of its own borrows the client's.
      accounts: mine.map((a) => ({ ...a, name: looksLikeId(a.name) ? name.trim() : a.name })),
      dashboardIds: boards.map((d) => d.id),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

/** Every account of a stored client, TikTok included; anything unknown is dropped, never read as Meta. */
export function parseAlertAccounts(json: string | null | undefined): AlertAccount[] {
  try {
    const list = JSON.parse(json || "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter((a) => a && isPlatform(a.platform) && typeof a.accountId === "string" && a.accountId)
      .map((a) => ({ platform: a.platform, accountId: a.accountId, name: String(a.name ?? a.accountId), currency: typeof a.currency === "string" ? a.currency : null }));
  } catch {
    return [];
  }
}

/** The Meta and Google accounts of a stored client (surfaces that do not read TikTok). */
export function parseAccounts(json: string | null | undefined): ClassicAlertAccount[] {
  return parseAlertAccounts(json).filter((a): a is ClassicAlertAccount => a.platform !== "tiktok");
}

export function clientInScope(scope: AccountScope, accounts: AlertAccount[]): boolean {
  if (scope.all) return true;
  return accounts.some((a) => platformAccountInScope(scope, a.platform, a.accountId));
}

export interface ExistingClient { id: string; key: string; accounts: AlertAccount[]; hasChannel: boolean }

export interface Reconciled {
  /** Draft → the stored client that carries on as it (null = to create). */
  pairs: Array<{ draft: ClientDraft; existingId: string | null }>;
  /** Stored clients no draft claims. */
  orphans: string[];
}

/**
 * Pure: which stored client is which draft. The key first; then, when the
 * key changed (an account attached to a client of the sheet, a dashboard
 * linking two accounts), the stored client that watched one of its accounts —
 * the one with a Slack channel if several did.
 */
export function reconcile(drafts: ClientDraft[], existing: ExistingClient[]): Reconciled {
  const byKey = new Map(existing.map((e) => [e.key, e]));
  const wanted = new Set(drafts.map((d) => d.key));
  const taken = new Set<string>();
  const pairs: Reconciled["pairs"] = drafts.map((draft) => {
    const same = byKey.get(draft.key);
    if (same) taken.add(same.id);
    return { draft, existingId: same?.id ?? null };
  });
  for (const p of pairs) {
    if (p.existingId) continue;
    const mine = new Set(p.draft.accounts.map((a) => node(a.platform, a.accountId)));
    const heir = existing
      .filter((e) => !taken.has(e.id) && !wanted.has(e.key) && e.accounts.some((a) => mine.has(node(a.platform, a.accountId))))
      .sort((a, b) => Number(b.hasChannel) - Number(a.hasChannel))[0];
    if (heir) { p.existingId = heir.id; taken.add(heir.id); }
  }
  return { pairs, orphans: existing.filter((e) => !taken.has(e.id)).map((e) => e.id) };
}

export interface SyncResult { clients: number; created: number; warnings: string[] }

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 160);

/** Names of the clients of the sheet: admin override, then the sheet, then the latest cockpit build. */
async function cockpitNames(sheet: SheetClient[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!sheet.length) {
    const last = await prisma.cockpitSnapshot.findFirst({ orderBy: { createdAt: "desc" }, select: { dataJson: true } }).catch(() => null);
    try {
      const data = JSON.parse(last?.dataJson ?? "{}") as { clients?: Array<{ key?: string; name?: string }>; unmatched?: Array<{ key?: string; name?: string }> };
      for (const c of [...(data.clients ?? []), ...(data.unmatched ?? [])]) if (c.key && c.name) names.set(c.key, c.name);
    } catch { /* no build yet */ }
  }
  for (const c of sheet) names.set(c.key, c.name);
  const overrides = await prisma.cockpitClient.findMany({ where: { name: { not: null } }, select: { key: true, name: true } });
  for (const o of overrides) if (o.name) names.set(o.key, o.name);
  return names;
}

/**
 * Pure: the TikTok accounts a client claims — attached to a dashboard (name
 * and currency checked at TikTok when attached) or to a client of the sheet.
 */
export function tiktokCandidates(
  sources: Array<{ externalId: string; label: string | null; config: string | null }>,
  cockpit: Array<{ platform: string; accountId: string; name?: string | null; currency?: string | null }>,
): TikTokCandidate[] {
  const out = new Map<string, TikTokCandidate>();
  for (const s of sources) {
    const id = s.externalId.trim();
    if (!id || out.has(id)) continue;
    let currency: string | null = null;
    try {
      const c = JSON.parse(s.config || "{}") as { currency?: unknown };
      if (typeof c.currency === "string" && c.currency) currency = c.currency;
    } catch { /* no currency */ }
    out.set(id, { accountId: id, name: s.label?.trim() || id, currency });
  }
  for (const c of cockpit) {
    const id = c.platform === "tiktok" ? c.accountId.trim() : "";
    if (!id || out.has(id)) continue;
    out.set(id, { accountId: id, name: c.name?.trim() || id, currency: c.currency ?? null });
  }
  return [...out.values()];
}

/** Reads the platforms and brings the stored list of clients up to date. */
export async function syncAlertClients(): Promise<SyncResult> {
  const warnings: string[] = [];
  const stored = await prisma.alertClient.findMany();
  const storedAccounts = stored.flatMap((s) => (s.gone ? [] : parseAlertAccounts(s.accountsJson)));
  // A platform that cannot be listed today keeps the accounts known yesterday.
  const keep = (platform: AvailableAccount["platform"]): AvailableAccount[] =>
    storedAccounts.filter((a): a is ClassicAlertAccount => a.platform === platform).map((a) => ({ ...a, active: true }));

  const [meta, google, lines] = await Promise.all([
    listMetaAccounts().catch((e) => { warnings.push(`Liste des comptes Meta indisponible (${errText(e)})`); return null; }),
    listGoogleAccounts().catch((e) => { warnings.push(`Liste des comptes Google Ads indisponible (${errText(e)})`); return null; }),
    fetchBudgetSheet().catch((e) => { warnings.push(`Feuille des budgets illisible (${errText(e)})`); return null; }),
  ]);
  if (google && !google.length) warnings.push("Aucun compte Google Ads lu");
  const complete = !!meta?.length && !!google?.length;
  const available = [...(meta?.length ? meta : keep("meta")), ...(google?.length ? google : keep("google"))];

  const sheet = lines ? sheetClients(lines, cockpitCalendar().month.key) : [];
  if (sheet.length && available.length) {
    await syncAccounts(sheet, available).catch((e) => { warnings.push(`Rapprochement comptes ↔ clients incomplet (${errText(e)})`); });
  }
  const [cockpit, boardRows, names] = await Promise.all([
    prisma.cockpitAccount.findMany({ select: { platform: true, accountId: true, clientKey: true, name: true, currency: true } }),
    prisma.dashboard.findMany({
      select: {
        id: true, name: true, metaAccountId: true, googleCustomerId: true, createdAt: true, slackChannel: true, slackChannelId: true, autoAlerts: true, autoAlertConfig: true,
        sources: { where: { kind: "tiktok", status: { not: "disabled" } }, select: { externalId: true, label: true, config: true } },
      },
    }),
    cockpitNames(sheet),
  ]);
  const dashboards = boardRows.map(({ sources, ...d }) => ({ ...d, tiktokAdvertiserIds: sources.map((s) => s.externalId) }));
  const tiktok = tiktokCandidates(boardRows.flatMap((d) => d.sources), cockpit);

  const drafts = buildClients({ available, tiktok, cockpit, cockpitNames: names, dashboards });
  const { pairs, orphans } = reconcile(drafts, stored.map((s) => ({ id: s.id, key: s.key, accounts: parseAlertAccounts(s.accountsJson), hasChannel: !!(s.slackChannelId || s.slackChannel) })));

  let created = 0;
  const boardById = new Map(dashboards.map((d) => [d.id, d]));
  // Keys move between rows (unique): free the ones that change before giving them away.
  const moving = pairs.filter((p) => p.existingId && stored.find((s) => s.id === p.existingId)?.key !== p.draft.key);
  for (const p of moving) await prisma.alertClient.update({ where: { id: p.existingId! }, data: { key: `moving:${p.existingId}` } });
  for (const { draft, existingId } of pairs) {
    const data = { key: draft.key, name: draft.name, accountsJson: JSON.stringify(draft.accounts), dashboardId: draft.dashboardIds[0] ?? null, gone: false };
    if (existingId) {
      await prisma.alertClient.update({ where: { id: existingId }, data });
      continue;
    }
    // First time this client is seen: what was set on its dashboards carries over.
    const boards = draft.dashboardIds.map((id) => boardById.get(id)).filter((d): d is NonNullable<typeof d> => !!d);
    const linked = boards.find((d) => d.slackChannelId || d.slackChannel);
    await prisma.alertClient.create({
      data: {
        ...data,
        slackChannel: linked?.slackChannel ?? null,
        slackChannelId: linked?.slackChannelId ?? null,
        autoAlerts: boards.every((d) => d.autoAlerts),
        autoAlertConfig: boards[0]?.autoAlertConfig ?? "{}",
      },
    });
    created++;
  }
  // Only a complete reading of both platforms may say that a client is gone.
  if (complete && orphans.length) await prisma.alertClient.updateMany({ where: { id: { in: orphans } }, data: { gone: true } });

  await adoptLegacyIncidents(dashboards).catch((e) => { warnings.push(`Reprise des incidents existants incomplète (${errText(e)})`); });
  return { clients: drafts.length, created, warnings };
}

/**
 * Incidents of the first version hang on a dashboard and have no account in
 * their key. They are attached to the client that watches the account, so
 * that what was already said in Slack is not said again.
 */
async function adoptLegacyIncidents(dashboards: DashboardRow[]): Promise<void> {
  const legacy = await prisma.autoIncident.findMany({ where: { clientId: null }, select: { id: true, dashboardId: true, key: true, scope: true, platform: true } });
  if (!legacy.length) return;
  const { groups } = groupDashboardsByAccount(dashboards);
  const clients = (await prisma.alertClient.findMany({ select: { id: true, accountsJson: true } })).map((c) => ({ id: c.id, accounts: parseAlertAccounts(c.accountsJson) }));
  for (const inc of legacy) {
    const group = groups.find((g) => inc.dashboardId && g.dashboardIds.includes(inc.dashboardId));
    const platform: AutoPlatform = inc.platform === "google" ? "google" : "meta";
    const raw = platform === "meta" ? group?.metaAccountId : group?.googleCustomerId;
    const accountId = raw ? norm(platform, raw) : null;
    const client = accountId ? clients.find((c) => c.accounts.some((a) => a.platform === platform && a.accountId === accountId)) : null;
    try {
      if (!client || !accountId) throw new Error("no client");
      await prisma.autoIncident.update({ where: { id: inc.id }, data: { clientId: client.id, key: `${inc.key}@${accountId}`, scope: `${inc.scope}@${accountId}` } });
    } catch {
      // Nothing to attach it to: the next scan finds the problem again if it is still there.
      await prisma.autoIncident.delete({ where: { id: inc.id } }).catch(() => undefined);
    }
  }
}

const SELECT = {
  id: true, key: true, name: true, accountsJson: true, dashboardId: true, slackChannel: true, slackChannelId: true,
  autoAlerts: true, autoAlertConfig: true, dormant: true, lastScanAt: true,
} as const;

export type StoredClient = Awaited<ReturnType<typeof loadAlertClients>>[number];

/** The clients a viewer may see, by name. The list is built on first use. */
export async function loadAlertClients(scope: AccountScope) {
  if ((await prisma.alertClient.count()) === 0) await syncAlertClients();
  const rows = await prisma.alertClient.findMany({ where: { gone: false }, select: SELECT, orderBy: { name: "asc" } });
  return rows
    .map(({ accountsJson, ...r }) => ({ ...r, accounts: parseAlertAccounts(accountsJson) }))
    .filter((r) => r.accounts.length && clientInScope(scope, r.accounts));
}
