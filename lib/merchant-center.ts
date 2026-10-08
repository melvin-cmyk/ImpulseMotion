/**
 * Google Merchant Center of a client (Dashboard).
 *
 * The agency's Google account reads every Merchant Center shared with it,
 * through the n8n MCP server « MCP Google Merchant Center » (read-only tools,
 * served by the relay: chat behind its allowlist, direct calls here). A client
 * is attached by choosing one of those accounts: stored as a DashboardSource
 * of kind "merchant" (externalId = account id, label = account name, config =
 * site and time zone). The reports and the copilot read the ids here — never
 * from a text written by a model.
 *
 * Report block (no AI): account issues, product statuses, Shopping clicks /
 * impressions / conversions over the period and the top products, all through
 * MCQL queries (search_reports) and renderaccountissues (get_account_issues).
 */

import { prisma } from "@/lib/prisma";
import { MERCHANT_SERVER } from "@/lib/mcp-whitelist";
import { relayDirectTool } from "@/lib/relay-tool";

export interface MerchantAccount {
  id: string;
  name: string;
  homePage: string | null;
  timeZone: string | null;
  language: string | null;
}

export interface MerchantIssue {
  title: string;
  severity: string | null;
  products: number | null;
  detail: string | null;
}

export interface MerchantReport {
  accountId: string;
  accountName: string | null;
  period: { since: string; until: string };
  /** Account-level and product-level alerts rendered by Google (empty = no issue). */
  issues: MerchantIssue[];
  /** Products by aggregated status over the first page read (Google caps a report page at 1 000 rows). */
  products: { total: number; approved: number; limited: number; disapproved: number; pending: number; other: number; inStock: number; truncated: boolean } | null;
  /** Shopping clicks, impressions, CTR, conversions and value attributed by Merchant Center over the period. */
  performance: { clicks: number; impressions: number; ctr: number | null; conversions: number; conversionValue: number | null; currency: string | null } | null;
  topProducts: Array<{ offerId: string; title: string; clicks: number; impressions: number; conversions: number; conversionValue: number | null }>;
  warnings: string[];
}

const ACCOUNT_ID_RE = /^\d{3,20}$/;
const ACCOUNTS_CACHE_MS = 10 * 60 * 1000;
let accountsCache: { at: number; accounts: MerchantAccount[] } | null = null;

export function normalizeMerchantId(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const id = String(raw).replace(/^accounts\//, "").replace(/\s+/g, "");
  return ACCOUNT_ID_RE.test(id) ? id : null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(String(v ?? "").replace(/[^0-9.-]/g, "")) || 0);

/** Unwraps the relay's answer: the tool returns one page object, sometimes inside a one-element array. */
function pages(result: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(result) ? result : [result];
  return list.filter((p): p is Record<string, unknown> => !!p && typeof p === "object");
}

export function parseMerchantAccounts(result: unknown): MerchantAccount[] {
  const out = new Map<string, MerchantAccount>();
  for (const page of pages(result)) {
    const rows = Array.isArray(page.accounts) ? page.accounts : [];
    for (const r of rows as Array<Record<string, unknown>>) {
      const id = normalizeMerchantId(r.accountId ?? r.name);
      if (!id) continue;
      const tz = r.timeZone && typeof r.timeZone === "object" ? text((r.timeZone as { id?: unknown }).id) : null;
      out.set(id, { id, name: text(r.accountName) ?? id, homePage: text(r.homePageUri), timeZone: tz, language: text(r.languageCode) });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

/** Merchant accounts the agency can read; cached 10 min per instance. Throws when the relay or n8n is down. */
export async function listMerchantAccounts(opts: { force?: boolean } = {}): Promise<MerchantAccount[]> {
  if (!opts.force && accountsCache && accountsCache.at > Date.now() - ACCOUNTS_CACHE_MS) return accountsCache.accounts;
  const result = await relayDirectTool(`${MERCHANT_SERVER}.list_merchant_accounts`, {}, 40_000);
  const accounts = parseMerchantAccounts(result);
  accountsCache = { at: Date.now(), accounts };
  return accounts;
}

export type MerchantCheck = { ok: true; account: MerchantAccount } | { ok: false; error: string };

/** Is this account one the agency reads? What is stored is Google's answer, never a name sent by the browser. */
export async function checkMerchantAccount(raw: unknown): Promise<MerchantCheck> {
  const id = normalizeMerchantId(raw);
  if (!id) return { ok: false, error: "Identifiant Merchant Center invalide : des chiffres seulement (en haut à droite de Merchant Center)." };
  let accounts: MerchantAccount[];
  try {
    accounts = await listMerchantAccounts();
  } catch (e) {
    console.error("[merchant] list_merchant_accounts:", e instanceof Error ? e.message : String(e));
    return { ok: false, error: "Merchant Center n'a pas pu être interrogé pour le moment. Réessayez dans un instant ; si cela persiste, prévenez un administrateur." };
  }
  const account = accounts.find((a) => a.id === id);
  if (!account) return { ok: false, error: "Ce compte Merchant Center n'est pas partagé avec le compte Google de l'agence : demandez l'accès au client, puis relancez." };
  return { ok: true, account };
}

/** Merchant account ids attached to a dashboard and still in service (oldest first). */
export async function getDashboardMerchantIds(dashboardId: string): Promise<string[]> {
  const rows = await prisma.dashboardSource.findMany({
    where: { dashboardId, kind: "merchant", status: { not: "disabled" } },
    orderBy: { createdAt: "asc" },
    select: { externalId: true },
  });
  return rows.map((r) => normalizeMerchantId(r.externalId)).filter((id): id is string => !!id);
}

/** Names of the OTHER dashboards this account is already attached to. */
export async function dashboardsWithMerchant(id: string, exceptDashboardId: string): Promise<string[]> {
  const rows = await prisma.dashboardSource.findMany({
    where: { kind: "merchant", externalId: id, dashboardId: { not: exceptDashboardId } },
    select: { dashboard: { select: { name: true } } },
  });
  return [...new Set(rows.map((r) => r.dashboard.name))];
}

/** Stores a checked account on a dashboard (same account again → its name and settings are refreshed). */
export async function attachMerchantAccount(dashboardId: string, account: MerchantAccount): Promise<{ id: string }> {
  const config = JSON.stringify({ homePage: account.homePage, timeZone: account.timeZone, language: account.language });
  return prisma.dashboardSource.upsert({
    where: { dashboardId_kind_externalId: { dashboardId, kind: "merchant", externalId: account.id } },
    create: { dashboardId, kind: "merchant", externalId: account.id, label: account.name, config, status: "active" },
    update: { label: account.name, config, status: "active", lastError: null },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// Report block
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Rows of a reports:search answer (one page, 1 000 rows at most as n8n asks). */
export function reportRows(result: unknown, view: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const page of pages(result)) {
    const rows = Array.isArray(page.results) ? page.results : [];
    for (const r of rows as Array<Record<string, unknown>>) {
      const row = r[view];
      if (row && typeof row === "object") out.push(row as Record<string, unknown>);
    }
  }
  return out;
}

function hasNextPage(result: unknown): boolean {
  return pages(result).some((p) => typeof p.nextPageToken === "string" && p.nextPageToken.length > 0);
}

function micros(v: unknown): { amount: number | null; currency: string | null } {
  if (!v || typeof v !== "object") return { amount: null, currency: null };
  const o = v as { amountMicros?: unknown; currencyCode?: unknown };
  const currency = text(o.currencyCode);
  const raw = o.amountMicros;
  if (raw === undefined || raw === null || raw === "") return { amount: null, currency };
  return { amount: Math.round(num(raw) / 10_000) / 100, currency };
}

export function parsePerformanceTotals(result: unknown): MerchantReport["performance"] {
  const rows = reportRows(result, "productPerformanceView");
  if (!rows.length) return null;
  let clicks = 0, impressions = 0, conversions = 0, value = 0, hasValue = false;
  let currency: string | null = null;
  for (const r of rows) {
    clicks += num(r.clicks);
    impressions += num(r.impressions);
    conversions += num(r.conversions);
    const m = micros(r.conversionValue);
    if (m.amount !== null && m.currency) { value += m.amount; hasValue = true; currency = currency ?? m.currency; }
  }
  return { clicks, impressions, ctr: impressions > 0 ? Math.round((clicks / impressions) * 10_000) / 100 : null, conversions, conversionValue: hasValue ? Math.round(value * 100) / 100 : null, currency };
}

export function parseTopProducts(result: unknown): MerchantReport["topProducts"] {
  return reportRows(result, "productPerformanceView")
    .map((r) => ({
      offerId: text(r.offerId) ?? "",
      title: (text(r.title) ?? text(r.offerId) ?? "").slice(0, 120),
      clicks: num(r.clicks),
      impressions: num(r.impressions),
      conversions: num(r.conversions),
      conversionValue: micros(r.conversionValue).amount,
    }))
    .filter((p) => p.title)
    .sort((a, b) => b.clicks - a.clicks);
}

/** aggregated_reporting_context_status: ELIGIBLE | ELIGIBLE_LIMITED | NOT_ELIGIBLE_OR_DISAPPROVED | PENDING | … */
export function parseProductStatuses(result: unknown): MerchantReport["products"] {
  const rows = reportRows(result, "productView");
  if (!rows.length) return null;
  const out = { total: rows.length, approved: 0, limited: 0, disapproved: 0, pending: 0, other: 0, inStock: 0, truncated: hasNextPage(result) };
  for (const r of rows) {
    const s = String(r.aggregatedReportingContextStatus ?? "").toUpperCase();
    if (s === "ELIGIBLE") out.approved++;
    else if (s === "ELIGIBLE_LIMITED") out.limited++;
    else if (s.includes("DISAPPROVED") || s.includes("NOT_ELIGIBLE")) out.disapproved++;
    else if (s === "PENDING") out.pending++;
    else out.other++;
    // Google writes "in stock" in feeds and IN_STOCK in reports: compare without case, spaces or underscores.
    if (String(r.availability ?? "").toLowerCase().replace(/[\s_]+/g, "") === "instock") out.inStock++;
  }
  return out;
}

/** renderaccountissues → alerts[] (account issues and product issues, with their impact). `[{}]` = nothing wrong. */
export function parseAccountIssues(result: unknown): MerchantIssue[] {
  const out: MerchantIssue[] = [];
  for (const page of pages(result)) {
    const alerts = Array.isArray(page.alerts) ? page.alerts : [];
    for (const a of alerts as Array<Record<string, unknown>>) {
      const impact = a.impact && typeof a.impact === "object" ? (a.impact as Record<string, unknown>) : {};
      const breakdowns = Array.isArray(impact.breakdowns) ? (impact.breakdowns as Array<Record<string, unknown>>) : [];
      const detail = breakdowns.flatMap((b) => (Array.isArray(b.details) ? b.details : [])).map((d) => (typeof d === "string" ? d : "")).filter(Boolean).join(" ; ");
      const products = typeof a.numProducts === "number" ? a.numProducts : typeof a.numProducts === "string" ? num(a.numProducts) : null;
      const title = text(a.title);
      if (!title) continue;
      out.push({ title: title.slice(0, 160), severity: text(impact.severity), products, detail: detail ? detail.slice(0, 300) : text(impact.message) });
    }
  }
  // Errors first, then by number of products touched.
  const rank = (s: string | null) => (s === "ERROR" ? 0 : s === "WARNING" ? 1 : 2);
  return out.sort((a, b) => rank(a.severity) - rank(b.severity) || (b.products ?? 0) - (a.products ?? 0));
}

export function performanceQuery(since: string, until: string): string {
  return `SELECT clicks, impressions, click_through_rate, conversions, conversion_value FROM product_performance_view WHERE date BETWEEN '${since}' AND '${until}'`;
}
export function topProductsQuery(since: string, until: string, limit = 10): string {
  return `SELECT offer_id, title, clicks, impressions, conversions, conversion_value FROM product_performance_view WHERE date BETWEEN '${since}' AND '${until}' ORDER BY clicks DESC LIMIT ${limit}`;
}
export const PRODUCT_STATUS_QUERY = "SELECT id, aggregated_reporting_context_status, availability FROM product_view";

async function search(accountId: string, query: string): Promise<unknown> {
  return relayDirectTool(`${MERCHANT_SERVER}.search_reports`, { account_id: accountId, query }, 60_000);
}

/** The Merchant block of a report for ONE account; every part fails on its own (warnings), the block never throws. */
export async function collectMerchantReport(accountId: string, since: string, until: string, accountName: string | null = null): Promise<MerchantReport> {
  if (!normalizeMerchantId(accountId) || !DATE_RE.test(since) || !DATE_RE.test(until)) throw new Error("compte Merchant ou période invalide");
  const report: MerchantReport = { accountId, accountName, period: { since, until }, issues: [], products: null, performance: null, topProducts: [], warnings: [] };
  const part = async (label: string, run: () => Promise<void>) => {
    try { await run(); } catch (e) { report.warnings.push(`${label} : ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`); }
  };
  await Promise.all([
    part("diagnostics Merchant", async () => { report.issues = parseAccountIssues(await relayDirectTool(`${MERCHANT_SERVER}.get_account_issues`, { account_id: accountId }, 60_000)).slice(0, 12); }),
    part("statuts produits Merchant", async () => { report.products = parseProductStatuses(await search(accountId, PRODUCT_STATUS_QUERY)); }),
    part("performance Merchant", async () => { report.performance = parsePerformanceTotals(await search(accountId, performanceQuery(since, until))); }),
    part("top produits Merchant", async () => { report.topProducts = parseTopProducts(await search(accountId, topProductsQuery(since, until))).slice(0, 10); }),
  ]);
  return report;
}

/** Merchant blocks for every account attached to a dashboard (the report takes them all). */
export async function collectDashboardMerchant(dashboardId: string, since: string, until: string): Promise<MerchantReport[]> {
  const rows = await prisma.dashboardSource.findMany({
    where: { dashboardId, kind: "merchant", status: { not: "disabled" } },
    orderBy: { createdAt: "asc" },
    select: { externalId: true, label: true },
  });
  const out: MerchantReport[] = [];
  for (const r of rows) {
    const id = normalizeMerchantId(r.externalId);
    if (id) out.push(await collectMerchantReport(id, since, until, r.label));
  }
  return out;
}

/** Lines of the report prompt for the Merchant blocks (same style as the CRM block). */
export function renderMerchantForPrompt(blocks: MerchantReport[]): string[] {
  const lines: string[] = [];
  for (const m of blocks) {
    lines.push(`\nMERCHANT CENTER (compte ${m.accountName ? `« ${m.accountName} » ` : ""}${m.accountId}, période ${m.period.since} → ${m.period.until}) :`);
    if (m.performance) {
      const p = m.performance;
      lines.push(`- Shopping (clics et conversions attribués par Merchant Center, campagnes Google et listings gratuits confondus — ne pas additionner à Google Ads) : ${p.clicks.toLocaleString("fr-FR")} clics, ${p.impressions.toLocaleString("fr-FR")} impressions, CTR ${p.ctr ?? "n/a"} %, ${p.conversions} conversions${p.conversionValue !== null ? `, valeur ${p.conversionValue.toLocaleString("fr-FR")} ${p.currency ?? ""}` : ""}`);
    }
    if (m.products) {
      const s = m.products;
      lines.push(`- Produits (${s.truncated ? "sur les 1 000 premiers" : `${s.total} au total`}) : ${s.approved} approuvés, ${s.limited} approuvés avec limitation, ${s.disapproved} refusés, ${s.pending} en attente${s.other ? `, ${s.other} autres` : ""} ; ${s.inStock} en stock`);
    }
    if (m.issues.length) {
      lines.push("- Problèmes signalés par Google (gravité, produits touchés) :");
      for (const i of m.issues) lines.push(`    · [${i.severity ?? "info"}] ${i.title}${i.products !== null ? ` — ${i.products} produits` : ""}${i.detail ? ` — ${i.detail}` : ""}`);
    } else if (!m.warnings.some((w) => w.startsWith("diagnostics"))) {
      lines.push("- Aucun problème de compte ni de flux signalé par Google.");
    }
    if (m.topProducts.length) {
      lines.push("- Top produits par clics (offre : clics, impressions, conversions, valeur) :");
      for (const p of m.topProducts) lines.push(`    · ${p.title} (${p.offerId}) : ${p.clicks} clics, ${p.impressions} impr, ${p.conversions} conv${p.conversionValue !== null ? `, ${p.conversionValue}` : ""}`);
    }
    if (m.warnings.length) lines.push(`- Données Merchant indisponibles : ${m.warnings.join(" ; ")}`);
  }
  return lines;
}
