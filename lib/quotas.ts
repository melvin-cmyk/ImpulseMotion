/**
 * Daily quotas of the AI generation and of the client bots, set by the admins
 * (/admin/quotas, stored in AppSetting "quotas"), and what was spent today.
 *
 * A day is a Paris day. Spend = CreativeAsset.costUsd of the images and videos
 * generated (the relay's list price per image or per second), never the chats
 * of the staff (those are the Max subscriptions, see lib/ai-usage.ts).
 */

import { prisma } from "@/lib/prisma";

export interface Quotas {
  /** USD a day for the whole team's image + video generation. 0 = no cap. */
  teamDailyUsd: number;
  /** USD a day per consultant. 0 = no cap. */
  userDailyUsd: number;
  /** Images (and videos) a day for the team. 0 = no cap. */
  teamDailyImages: number;
  /** Messages a day per client bot (all its users together), unless the bot sets its own. 0 = unlimited. */
  botDailyMessages: number;
  /** Percentage of a cap from which the reminder turns amber. */
  warnAtPct: number;
}

export const DEFAULT_QUOTAS: Quotas = { teamDailyUsd: 10, userDailyUsd: 5, teamDailyImages: 300, botDailyMessages: 0, warnAtPct: 80 };
const KEY = "quotas";

const num = (v: unknown, fallback: number, max = 1_000_000) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(max, v) : fallback);

export function parseQuotas(json: string | null | undefined): Quotas {
  let raw: Record<string, unknown> = {};
  try { raw = json ? (JSON.parse(json) as Record<string, unknown>) : {}; } catch { raw = {}; }
  return {
    teamDailyUsd: Math.round(num(raw.teamDailyUsd, DEFAULT_QUOTAS.teamDailyUsd) * 100) / 100,
    userDailyUsd: Math.round(num(raw.userDailyUsd, DEFAULT_QUOTAS.userDailyUsd) * 100) / 100,
    teamDailyImages: Math.round(num(raw.teamDailyImages, DEFAULT_QUOTAS.teamDailyImages)),
    botDailyMessages: Math.round(num(raw.botDailyMessages, DEFAULT_QUOTAS.botDailyMessages)),
    warnAtPct: Math.round(Math.min(100, Math.max(10, num(raw.warnAtPct, DEFAULT_QUOTAS.warnAtPct)))),
  };
}

export async function readQuotas(): Promise<Quotas> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  return parseQuotas(row?.valueJson);
}

export async function writeQuotas(patch: Partial<Quotas>, updatedBy: string | null): Promise<Quotas> {
  const next = parseQuotas(JSON.stringify({ ...(await readQuotas()), ...patch }));
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, valueJson: JSON.stringify(next), updatedBy }, update: { valueJson: JSON.stringify(next), updatedBy } });
  return next;
}

/** Midnight of today in Paris, as an instant. */
export function parisDayStart(now = new Date()): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const guess = new Date(`${ymd}T00:00:00Z`);
  // The hour Paris shows at that UTC midnight is Paris' offset (1 or 2).
  const offsetHours = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }).format(guess)) % 24;
  return new Date(guess.getTime() - offsetHours * 3_600_000);
}

export interface SpentToday { team: { usd: number; images: number }; user: { usd: number; images: number } }

/** What the team and the caller spent since midnight (Paris) on generated visuals. */
export async function spentToday(userId: string, now = new Date()): Promise<SpentToday> {
  const since = parisDayStart(now);
  const rows = await prisma.creativeAsset.findMany({
    where: { createdAt: { gte: since }, status: { not: "failed" }, kind: { in: ["image", "video"] }, origin: { not: "asset" } },
    select: { createdById: true, costUsd: true },
  });
  const team = { usd: 0, images: 0 };
  const user = { usd: 0, images: 0 };
  for (const r of rows) {
    team.usd += r.costUsd; team.images += 1;
    if (r.createdById === userId) { user.usd += r.costUsd; user.images += 1; }
  }
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { team: { usd: round(team.usd), images: team.images }, user: { usd: round(user.usd), images: user.images } };
}

export interface QuotaCheck { ok: boolean; reason?: string; warn?: string }

const usd = (v: number) => `${v.toFixed(2).replace(".", ",")} $`;

/**
 * Whether a generation of `count` visuals estimated at `estimateUsd` may start,
 * and the sentence to show when it may not (or when a cap is close).
 */
export function checkGeneration(q: Quotas, spent: SpentToday, estimateUsd: number, count: number): QuotaCheck {
  const teamUsd = spent.team.usd + estimateUsd;
  const userUsd = spent.user.usd + estimateUsd;
  const teamImages = spent.team.images + count;
  if (q.teamDailyUsd > 0 && teamUsd > q.teamDailyUsd + 1e-9) {
    return { ok: false, reason: `Plafond de l'équipe atteint : ${usd(spent.team.usd)} déjà dépensés aujourd'hui sur ${usd(q.teamDailyUsd)}, cette génération coûterait ${usd(estimateUsd)}. Un admin peut relever le quota (Admin → Quotas), sinon demain.` };
  }
  if (q.userDailyUsd > 0 && userUsd > q.userDailyUsd + 1e-9) {
    return { ok: false, reason: `Ton plafond du jour est atteint : ${usd(spent.user.usd)} dépensés sur ${usd(q.userDailyUsd)}, cette génération coûterait ${usd(estimateUsd)}. Un admin peut relever le quota (Admin → Quotas), sinon demain.` };
  }
  if (q.teamDailyImages > 0 && teamImages > q.teamDailyImages) {
    return { ok: false, reason: `Plafond d'images du jour atteint pour l'équipe : ${spent.team.images} sur ${q.teamDailyImages}.` };
  }
  const warns: string[] = [];
  const pct = (v: number, cap: number) => (cap > 0 ? (v / cap) * 100 : 0);
  if (q.teamDailyUsd > 0 && pct(teamUsd, q.teamDailyUsd) >= q.warnAtPct) warns.push(`l'équipe sera à ${usd(teamUsd)} sur ${usd(q.teamDailyUsd)} aujourd'hui`);
  if (q.userDailyUsd > 0 && pct(userUsd, q.userDailyUsd) >= q.warnAtPct) warns.push(`tu seras à ${usd(userUsd)} sur ${usd(q.userDailyUsd)}`);
  return { ok: true, ...(warns.length ? { warn: `Attention : ${warns.join(" ; ")}.` } : {}) };
}

/** Messages exchanged with a bot since midnight (Paris), all its users together (AiUsage lines of the bot). */
export async function botMessagesToday(botId: string, now = new Date()): Promise<number> {
  return prisma.aiUsage.count({ where: { botId, createdAt: { gte: parisDayStart(now) } } });
}

/** The daily cap of a bot: its own when set, else the agency's. 0 = unlimited. */
export function botDailyCap(bot: { dailyMessages: number | null }, q: Quotas): number {
  return bot.dailyMessages ?? q.botDailyMessages;
}
