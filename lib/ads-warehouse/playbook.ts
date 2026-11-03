/**
 * Playbook of a client — Motion's Playbook: the learnings the team keeps about
 * a client's creatives, so they are not lost between two analyses and the AI
 * builds on them.
 *   - entries come from a consultant (by hand, from a creative's sheet, from a
 *     copilot answer) → saved at once; or from the AI (« Proposer des
 *     apprentissages ») → « À valider » until a consultant accepts / declines;
 *   - playbookContext() gives the saved entries to the Analyse Ads copilot.
 */

import { prisma } from "@/lib/prisma";
import { relayComplete, parseLooseJson } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";
import { queryAds, type AdsQuery } from "./query";
import { METRIC_BY_KEY, fmtMetric } from "./metrics-ui";
import type { MetricKey } from "./query";

export type PlaybookStatus = "review" | "saved" | "declined";
export type PlaybookSource = "manual" | "creative" | "copilot" | "ai";
export const PLAYBOOK_SOURCES: PlaybookSource[] = ["manual", "creative", "copilot", "ai"];

export interface PlaybookRef { creativeKey?: string; platform?: string; adId?: string; label?: string; imageUrl?: string | null; linkUrl?: string | null }

export interface PlaybookEntry {
  id: string;
  status: PlaybookStatus;
  source: PlaybookSource;
  title: string;
  userNote: string;
  aiNote: string;
  ref: PlaybookRef;
  createdByName: string;
  statusByName: string;
  createdAt: string;
}

export const PLAYBOOK_KEY_RE = /^(client|meta):[\w-]{3,40}$/;
/** Motion refuses to add a too short finding to the playbook. */
export const PLAYBOOK_MIN_CHARS = 20;

const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

export function cleanRef(v: unknown): PlaybookRef {
  if (!v || typeof v !== "object") return {};
  const r = v as Record<string, unknown>;
  const out: PlaybookRef = {};
  if (r.creativeKey) out.creativeKey = str(r.creativeKey, 200);
  if (r.platform) out.platform = str(r.platform, 20);
  if (r.adId) out.adId = str(r.adId, 60);
  if (r.label) out.label = str(r.label, 200);
  // Own images go through /api/ads/image (relative), others must be https.
  if (typeof r.imageUrl === "string" && /^(\/api\/|https:\/\/)/.test(r.imageUrl)) out.imageUrl = r.imageUrl.slice(0, 1000);
  if (typeof r.linkUrl === "string" && /^(\/(?![/\\])|https:\/\/)/.test(r.linkUrl)) out.linkUrl = r.linkUrl.slice(0, 1000);
  return out;
}

type Row = { id: string; status: string; source: string; title: string; userNote: string; aiNote: string; refJson: string; createdByName: string; statusByName: string; createdAt: Date };

export function toEntry(r: Row): PlaybookEntry {
  let ref: PlaybookRef = {};
  try { ref = cleanRef(JSON.parse(r.refJson)); } catch { /* ignore */ }
  return { id: r.id, status: r.status as PlaybookStatus, source: (PLAYBOOK_SOURCES.includes(r.source as PlaybookSource) ? r.source : "manual") as PlaybookSource, title: r.title, userNote: r.userNote, aiNote: r.aiNote, ref, createdByName: r.createdByName, statusByName: r.statusByName, createdAt: r.createdAt.toISOString() };
}

export async function listPlaybook(accountKey: string): Promise<{ saved: PlaybookEntry[]; review: PlaybookEntry[] }> {
  const rows = await prisma.adPlaybookEntry.findMany({ where: { accountKey, status: { in: ["saved", "review"] } }, orderBy: { createdAt: "desc" }, take: 300 });
  const all = rows.map(toEntry);
  return { saved: all.filter((e) => e.status === "saved"), review: all.filter((e) => e.status === "review") };
}

export async function reviewCount(accountKey: string): Promise<number> {
  return prisma.adPlaybookEntry.count({ where: { accountKey, status: "review" } });
}

/** The saved learnings, for the AI's system prompt ("" when none). */
export async function playbookContext(accountKey: string, maxChars = 3500): Promise<string> {
  const rows = await prisma.adPlaybookEntry.findMany({ where: { accountKey, status: "saved" }, orderBy: { createdAt: "desc" }, take: 40, select: { title: true, userNote: true, aiNote: true, createdAt: true } });
  if (!rows.length) return "";
  const lines: string[] = [];
  let size = 0;
  for (const r of rows) {
    const note = (r.userNote || r.aiNote).replace(/\s+/g, " ").slice(0, 400);
    const l = `- ${r.title}${note ? ` : ${note}` : ""} (${r.createdAt.toISOString().slice(0, 10)})`;
    if (size + l.length > maxChars) break;
    lines.push(l); size += l.length;
  }
  return lines.join("\n");
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const METRICS: MetricKey[] = ["spend", "ctr", "cpa", "roas", "hookRate", "holdRate"];

const SYSTEM = `Tu es stratège créatif en acquisition payante pour une agence. On te donne les créas d'UN annonceur sur 30 jours (chiffres, format, tags, textes) et la moyenne du compte, plus les apprentissages déjà notés dans son playbook. Propose de NOUVEAUX apprentissages durables, ceux qu'un consultant voudrait retenir pour les prochaines créas (ex. « Les vidéos face caméra < 15 s ont un CPA 30 % sous la moyenne »).
Règles :
- 3 à 5 apprentissages, chacun appuyé sur des chiffres du rapport et au moins une créa citée par son numéro ;
- pas de doublon avec le playbook existant, pas de généralité marketing ;
- titre court (10 mots max), note de 1 à 3 phrases avec les chiffres.
Réponds UNIQUEMENT en JSON : {"learnings":[{"title":"…","note":"…","creatives":[1,4]}]}`;

/** The AI reads the last 30 days and proposes learnings, stored « À valider ». Returns how many. */
export async function proposeLearnings(q: AdsQuery, accountKey: string, user: { id: string; email: string | null; role: string; name: string }): Promise<number> {
  const until = new Date(); until.setUTCDate(until.getUTCDate() - 1);
  const since = new Date(until); since.setUTCDate(since.getUTCDate() - 29);
  const res = await queryAds({ ...q, groupBy: "creative", filters: {}, compare: null, range: { since: iso(since), until: iso(until) }, sort: { key: "spend", dir: "desc" }, limit: 40 });
  const rows = res.rows.filter((r) => r.sample && r.metrics.spend > 0);
  if (rows.length < 3) throw new Error("Pas assez de créas avec de la dépense sur 30 jours pour en tirer des apprentissages.");
  const cur = res.currency;
  const m = (x: typeof res.benchmark) => METRICS.filter((k) => !(k === "roas" && res.benchmark.roasUnavailable)).map((k) => `${METRIC_BY_KEY[k].short}=${fmtMetric(k, x[k], cur, x)}`).join(" · ");
  const lines = rows.map((r, i) => {
    const a = r.sample!;
    const tags = Object.entries(a.tags).filter(([k]) => !/^(s|t)\d+$/.test(k)).map(([k, v]) => `${k}=${v}`).join(", ");
    const txt = [a.title, a.body].filter(Boolean).join(" — ").replace(/\s+/g, " ").slice(0, 200);
    return `${i + 1}. ${r.label.slice(0, 90)} [${a.format}${r.launch ? `, lancée ${r.launch}` : ""}]${tags ? ` {${tags}}` : ""}\n   ${m(r.metrics)}${txt ? `\n   texte: ${txt}` : ""}`;
  });
  const existing = await playbookContext(accountKey, 2500);
  const pending = await prisma.adPlaybookEntry.findMany({ where: { accountKey, status: { in: ["review", "declined"] } }, select: { title: true }, take: 40, orderBy: { createdAt: "desc" } });
  const prompt = [
    `Moyenne du compte : ${m(res.benchmark)}`,
    res.benchmark.roasUnavailable ? "Pas de valeur de conversion suivie : raisonne en CPA." : "",
    `Playbook existant :\n${existing || "(vide)"}`,
    pending.length ? `Déjà proposés ou refusés (ne pas reproposer) :\n${pending.map((p) => `- ${p.title}`).join("\n")}` : "",
    `Créas (30 derniers jours) :\n${lines.join("\n")}`,
  ].filter(Boolean).join("\n\n");
  const text = await relayComplete(
    { messages: [{ role: "user", content: prompt }], systemPrompt: SYSTEM, allowedServers: [], accountScope: {}, model: "sonnet", effort: "low", maxTurns: 1 },
    { maxMs: 110_000, onUsage: (usage) => void recordAiUsage(usage, { feature: "analyse_playbook", clientName: accountKey, user }) },
  );
  const parsed = parseLooseJson<{ learnings?: Array<{ title?: string; note?: string; creatives?: unknown[] }> }>(text);
  const items = (parsed?.learnings ?? []).map((l) => ({ title: str(l.title, 140), note: str(l.note, 1200), creatives: Array.isArray(l.creatives) ? l.creatives.map(Number).filter((n) => n >= 1 && n <= rows.length) : [] })).filter((l) => l.title && l.note).slice(0, 5);
  if (!items.length) throw new Error("Réponse de l'IA illisible, réessaie.");
  await prisma.adPlaybookEntry.createMany({
    data: items.map((l) => {
      const row = l.creatives.length ? rows[l.creatives[0] - 1] : null;
      const ref: PlaybookRef = row?.sample ? { creativeKey: row.key, platform: row.sample.platform, adId: row.sample.adId, label: row.label.slice(0, 200), imageUrl: row.sample.platform === "meta" ? `/api/ads/image?adId=${encodeURIComponent(row.sample.adId)}` : (row.sample.imageUrl ?? row.sample.thumbnailUrl ?? null), linkUrl: `/analyse?creative=${encodeURIComponent(row.key)}` } : {};
      return { accountKey, status: "review", source: "ai", title: l.title, aiNote: l.note, refJson: JSON.stringify(ref), createdById: user.id, createdByName: "IA" };
    }),
  });
  return items.length;
}
