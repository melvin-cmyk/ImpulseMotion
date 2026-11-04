/**
 * Weekly creative recap (Motion's « Weekly creative pulse »), one Slack message
 * per client in its internal channel (#c_<client>, AlertClient.slackChannelId,
 * matched by name on the alerts admin page): the week's KPIs vs the week
 * before, top 3 creatives, scaling / declining, new creatives, opportunities,
 * link to the Leaderboard. Built from the creative warehouse (no platform call).
 *
 * Fatigue section (lib/ads-warehouse/fatigue.ts): the creatives that still take
 * budget while their efficiency wears off, with their visual when the message
 * goes out as Slack blocks (the n8n flow forwards `blocks`; `text` stays the
 * notification / fallback).
 *
 * Sending is gated: WEEKLY_RECAP_SEND=1, else dry run (the report says what
 * would have been posted). Clients without spend this week are skipped.
 */

import { prisma } from "@/lib/prisma";
import { parseAlertAccounts } from "@/lib/auto-alerts/clients";
import { postDigest } from "@/lib/auto-alerts/slack";
import { queryLeaderboard } from "@/lib/ads-warehouse/leaderboard";
import { queryAds } from "@/lib/ads-warehouse/query";
import { detectFatigue, FATIGUE_VERDICT_LABEL, type FatigueHit } from "@/lib/ads-warehouse/fatigue";
import { fbcdnUsable } from "@/lib/ads-warehouse/cdn";
import { freshMetaAdImage } from "@/lib/ads-warehouse/preview";
import { opportunitiesOf, OPPORTUNITY_LABEL } from "@/lib/ads-warehouse/opportunities";
import { deltaPct, fmtMetric } from "@/lib/ads-warehouse/metrics-ui";
import type { AdsQuery, MetricKey } from "@/lib/ads-warehouse/query";
import type { WarehousePlatform } from "@/lib/ads-warehouse/types";

const APP_URL = (process.env.APP_PUBLIC_URL ?? "https://impulsemotion.ai").replace(/\/$/, "");
const MIN_WEEK_SPEND = 20;

export interface RecapResult { clientId: string; clientName: string; channel: string | null; text: string | null; status: "sent" | "dry" | "skipped" | "error"; reason?: string; fatigue?: number }

/** Slack Block Kit block (only the shapes used here). */
export type SlackBlock = Record<string, unknown>;
export interface Recap { text: string | null; blocks?: SlackBlock[]; fatigue?: number; reason?: string }

const SECTION_MAX = 2900;

/** Public image of a creative for Slack (Meta signed URLs refreshed when expired), or null. */
async function slackImageOf(hit: FatigueHit): Promise<string | null> {
  const s = hit.row.sample;
  if (!s) return null;
  const stored = s.imageUrl ?? s.thumbnailUrl;
  if (stored && /^https:\/\//.test(stored) && fbcdnUsable(stored, 24 * 3600_000)) return stored;
  if (s.platform === "meta") return (await freshMetaAdImage(s.adId).catch(() => null))?.url ?? null;
  return null;
}

/** mrkdwn lines → section blocks of at most SECTION_MAX characters. */
function sections(lines: string[]): SlackBlock[] {
  const out: SlackBlock[] = [];
  let cur = "";
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > SECTION_MAX) { out.push({ type: "section", text: { type: "mrkdwn", text: cur } }); cur = ""; }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur.trim()) out.push({ type: "section", text: { type: "mrkdwn", text: cur } });
  return out;
}

const fmtDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function delta(k: MetricKey, cur: number, prev: number | null | undefined): string {
  const d = deltaPct(cur, prev);
  if (d === null || Math.abs(d) < 1) return "";
  return ` (${d > 0 ? "+" : ""}${Math.round(d)} %)`;
}

const MIN_MEANINGFUL_ROAS = 0.5;

/** Recap text of one client for the week ending yesterday; null when the client did not spend. */
export async function buildRecap(client: { id: string; name: string; accountsJson: string }, until?: string): Promise<Recap> {
  const accounts = parseAlertAccounts(client.accountsJson).map((a) => ({ platform: a.platform as WarehousePlatform, id: String(a.accountId).replace(/^act_/, "").replace(/-/g, "") }));
  if (!accounts.length) return { text: null, reason: "aucun compte" };
  const end = until ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const q: AdsQuery = { platforms: Array.from(new Set(accounts.map((a) => a.platform))), accountIds: Array.from(new Set(accounts.map((a) => a.id))), accounts, range: { since: end, until: end }, groupBy: "creative" };
  const lb = await queryLeaderboard(q);
  const cur = lb.overview.current, prev = lb.overview.previous, cy = lb.overview.currency;
  if (cur.spend < MIN_WEEK_SPEND) return { text: null, reason: `dépense de la semaine < ${MIN_WEEK_SPEND}` };

  const kpi: string[] = [`Dépenses *${fmtMetric("spend", cur.spend, cy)}*${delta("spend", cur.spend, prev?.spend)}`];
  if (cur.conversions > 0) kpi.push(`Conversions *${Math.round(cur.conversions)}*${delta("conversions", cur.conversions, prev?.conversions)}`, `CPA *${fmtMetric("cpa", cur.cpa, cy)}*${delta("cpa", cur.cpa, prev?.cpa)}`);
  // Under 0.5× the purchase value is nominal (lead gen such as ICN: 0.08×), so ROAS means nothing there.
  if (!cur.roasUnavailable && !cur.estimated && cur.roas >= MIN_MEANINGFUL_ROAS) kpi.push(`ROAS *${fmtMetric("roas", cur.roas, cy, cur)}*${delta("roas", cur.roas, prev?.roas)}`);
  kpi.push(`CTR *${fmtMetric("ctr", cur.ctr, cy)}*${delta("ctr", cur.ctr, prev?.ctr)}`);

  const link = (key: string, label: string) => `<${APP_URL}/analyse?client=${encodeURIComponent(client.id)}&creative=${encodeURIComponent(key)}|${esc(short(label))}>`;
  const lines: string[] = [];
  lines.push(`*📊 Récap créas de la semaine — ${esc(client.name)}*  (${fmtDay(lb.period.since)} → ${fmtDay(lb.period.until)})`);
  lines.push(kpi.join(" · "));
  if (lb.leaderboard.length) {
    lines.push("", "*🏆 Top 3 de la semaine*");
    for (const r of lb.leaderboard.slice(0, 3)) {
      const move = r.rankChange === null ? " · 🆕 entrée" : r.rankChange > 0 ? ` · ▲${r.rankChange}` : r.rankChange < 0 ? ` · ▼${-r.rankChange}` : "";
      const perf = r.metrics.conversions > 0 ? ` · CPA ${fmtMetric("cpa", r.metrics.cpa, cy)}` : ` · CTR ${fmtMetric("ctr", r.metrics.ctr, cy)}`;
      lines.push(`${r.rank}. ${link(r.key, r.label)} — ${fmtMetric("spend", r.metrics.spend, cy)}${perf}${move}`);
    }
  }
  const named = (rows: typeof lb.trends.rows.scaling) => rows.slice(0, 3).map((r) => `${link(r.key, r.label)} (${r.trend?.wow !== null && r.trend?.wow !== undefined ? `${r.trend.wow > 0 ? "+" : ""}${Math.round(r.trend.wow)} %` : "nouvelle"})`).join(", ");
  if (lb.trends.counts.scaling) lines.push(`*📈 En hausse (${lb.trends.counts.scaling})* : ${named(lb.trends.rows.scaling)}`);
  if (lb.trends.counts.declining) lines.push(`*📉 En baisse (${lb.trends.counts.declining})* : ${named(lb.trends.rows.declining)}`);
  if (lb.trends.counts.paused) lines.push(`*⏸ Arrêtées cette semaine* : ${lb.trends.counts.paused}`);
  lines.push(`*🆕 Créas lancées* : ${lb.overview.launched}`);
  const opps = opportunitiesOf(lb.leaderboard, lb.spendThreshold);
  if (opps.size) {
    const first = lb.leaderboard.find((r) => opps.has(r.key))!;
    lines.push(`*🚩 Opportunités* : ${opps.size} — ex. ${OPPORTUNITY_LABEL[opps.get(first.key)!.type].toLowerCase()} sur ${link(first.key, first.label)}`);
  }
  // Fatigue: this week vs the week before, creatives that still take budget.
  const week = await queryAds({ ...q, range: { since: lb.period.since, until: lb.period.until }, compare: { since: lb.period.previousSince, until: lb.period.previousUntil }, sort: { key: "spend", dir: "desc" }, limit: 60 });
  const hits = detectFatigue(week.rows, { minSpend: Math.max(50, lb.spendThreshold), money: (v) => fmtMetric("cpa", v, cy) });
  const fatigueLine = (h: FatigueHit) => `${link(h.row.key, h.row.label)} — ${fmtMetric("spend", h.row.metrics.spend, cy)} cette semaine · *${FATIGUE_VERDICT_LABEL[h.verdict]}* : ${h.signals.map((x) => x.text).join(", ")}`;
  const fatigueUrl = `${APP_URL}/analyse?client=${encodeURIComponent(client.id)}&view=fatigue`;
  const head = [...lines];
  if (hits.length) {
    lines.push("", `*🥱 Créas en fatigue (${hits.length})* — elles prennent encore du budget mais s'essoufflent (vs la semaine d'avant)`);
    for (const h of hits) lines.push(`• ${fatigueLine(h)}`);
  }
  const footer = `<${APP_URL}/analyse?client=${encodeURIComponent(client.id)}&tab=leaderboard|Ouvrir le leaderboard dans ImpulseMotion>${hits.length ? ` · <${fatigueUrl}|Voir la fatigue>` : ""}`;
  lines.push("", footer);

  const blocks: SlackBlock[] = [...sections(head)];
  if (hits.length) {
    blocks.push({ type: "divider" }, { type: "section", text: { type: "mrkdwn", text: `*🥱 Créas en fatigue (${hits.length})* — elles prennent encore du budget mais s'essoufflent (vs la semaine d'avant)` } });
    const images = await Promise.all(hits.map(slackImageOf));
    hits.forEach((h, i) => {
      const section: SlackBlock = { type: "section", text: { type: "mrkdwn", text: fatigueLine(h).slice(0, SECTION_MAX) } };
      if (images[i]) section.accessory = { type: "image", image_url: images[i], alt_text: short(h.row.label, 100) };
      blocks.push(section);
    });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer }] });
  return { text: lines.join("\n"), blocks, fatigue: hits.length };
}

/** Runs the recap for the clients that have a Slack channel (or the given ones). */
export async function runWeeklyRecap(opts: { send: boolean; clientIds?: string[]; deadline: number }): Promise<RecapResult[]> {
  const clients = await prisma.alertClient.findMany({
    where: { gone: false, dormant: false, ...(opts.clientIds?.length ? { id: { in: opts.clientIds } } : {}) },
    select: { id: true, name: true, accountsJson: true, slackChannel: true, slackChannelId: true },
    orderBy: { name: "asc" },
  });
  const out: RecapResult[] = [];
  for (const c of clients) {
    if (Date.now() > opts.deadline) break;
    const channel = c.slackChannelId ?? null;
    if (!channel && !opts.clientIds?.length) continue;
    try {
      const { text, blocks, fatigue, reason } = await buildRecap(c);
      if (!text) { out.push({ clientId: c.id, clientName: c.name, channel: c.slackChannel, text: null, status: "skipped", reason }); continue; }
      if (!channel) { out.push({ clientId: c.id, clientName: c.name, channel: null, text, status: "skipped", reason: "aucun salon Slack rattaché (Admin › Alertes)" }); continue; }
      if (opts.send) { await postDigest(channel, text, { id: c.id, name: c.name }, blocks); out.push({ clientId: c.id, clientName: c.name, channel: c.slackChannel, text, status: "sent", fatigue }); }
      else out.push({ clientId: c.id, clientName: c.name, channel: c.slackChannel, text, status: "dry", fatigue });
    } catch (e) {
      out.push({ clientId: c.id, clientName: c.name, channel: c.slackChannel, text: null, status: "error", reason: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  return out;
}
