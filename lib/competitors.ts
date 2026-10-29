/**
 * Competitors of a client — server side (pure rules in ./competitors-core.ts).
 *
 *   getClientCompetitors(client, { suggest })  the merged list (saved + HQ brief + AI suggestions),
 *                                              each name with its origin. With `suggest`, the AI is
 *                                              asked when saved + HQ give fewer than 3 (cached 30 days).
 *   suggestCompetitors(client, user)           one text call through the relay (Sonnet, low, no tool):
 *                                              client name, landing domains and ad texts of the
 *                                              warehouse (90 days), the HQ brief → 5 French brands.
 *   addClientCompetitor / removeClientCompetitor  the consultants' edits (AppSetting per client).
 * Used by Analyse Ads (« Concurrents », /api/competitors) and Mo (quick path).
 */

import { prisma } from "@/lib/prisma";
import { relayComplete } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";
import { isHqContextFresh } from "@/lib/hq-client-context";
import { competitorsFromBrief } from "@/lib/mo/brief";
import { clientDashboardIds } from "@/lib/creas/factory";
import { clientWarehouseAccounts } from "@/lib/creas/context";
import { queryAds } from "@/lib/ads-warehouse/query";
import {
  COMPETITORS_KEY, SUGGESTIONS_KEY, SUGGEST_SYSTEM, addCompetitor, landingDomains, mergeCompetitors, needsSuggestions, parseSetting,
  parseSuggestions, parseSuggestionsSetting, removeCompetitor, suggestionPrompt, suggestionsFresh, type Competitor, type CompetitorSetting,
} from "@/lib/competitors-core";

export interface CompetitorClient { id: string; name: string }
export interface CompetitorUser { id: string; email: string | null; role: string }
export interface ClientCompetitors {
  competitors: Competitor[];
  /** Saved + HQ give fewer than 3 names and no fresh suggestion is cached: `suggest` would ask the AI. */
  needsSuggestions: boolean;
  suggestedAt: string | null;
  /** The HQ brief cached on the client's dashboards was found (it may name no competitor). */
  hqBrief: boolean;
  warning?: string;
}

const MODEL = (process.env.AI_CREAS_MODEL as "sonnet" | "opus" | undefined) ?? "sonnet";
const TZ = "Europe/Paris";
const isoParis = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

async function readSetting(key: string): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  return row?.valueJson ?? null;
}

async function writeSetting(key: string, value: unknown, userId: string | null): Promise<void> {
  const valueJson = JSON.stringify(value);
  await prisma.appSetting.upsert({ where: { key }, create: { key, valueJson, updatedBy: userId }, update: { valueJson, updatedBy: userId } });
}

/** The raw HQ brief cached on one of the client's dashboards (7 days, the freshest), or null — never an HQ call. */
export async function clientRawBrief(client: Pick<CompetitorClient, "id">): Promise<string | null> {
  const ids = await clientDashboardIds(client);
  if (!ids.length) return null;
  const rows = await prisma.dashboard.findMany({ where: { id: { in: ids }, hqContextMd: { not: null } }, select: { hqContextMd: true, hqContextAt: true }, orderBy: { hqContextAt: "desc" }, take: 3 });
  return rows.find((d) => isHqContextFresh(d))?.hqContextMd ?? rows[0]?.hqContextMd ?? null;
}

/** What the warehouse says of the client: landing domains and ad texts of the last 90 days (top 30 ads by spend). */
async function warehouseSignals(clientId: string): Promise<{ domains: string[]; texts: string[] }> {
  const accounts = await clientWarehouseAccounts(clientId);
  if (!accounts.length) return { domains: [], texts: [] };
  const until = isoParis(new Date(Date.now() - 86_400_000));
  const since = isoParis(new Date(Date.now() - 90 * 86_400_000));
  const res = await queryAds({ platforms: [...new Set(accounts.map((a) => a.platform))], accountIds: [...new Set(accounts.map((a) => a.id))], accounts, range: { since, until }, groupBy: "ad", sort: { key: "spend", dir: "desc" }, limit: 30 });
  const samples = res.rows.map((r) => r.sample).filter((s): s is NonNullable<typeof s> => !!s);
  return { domains: landingDomains(samples.map((s) => s.landingUrl)), texts: samples.flatMap((s) => [s.title ?? "", s.body ?? ""]).filter(Boolean) };
}

// One suggestion call at a time per client (two tabs, Mo and Analyse Ads at once).
const inflight = new Map<string, Promise<string[]>>();

/** Five competitor names proposed by the AI, stored for 30 days. Never throws: [] when the relay or the model fails. */
export async function suggestCompetitors(client: CompetitorClient, user: CompetitorUser | null, opts: { brief?: string | null; known?: string[] } = {}): Promise<string[]> {
  const running = inflight.get(client.id);
  if (running) return running;
  const job = (async () => {
    try {
      const [signals, brief] = await Promise.all([
        warehouseSignals(client.id).catch(() => ({ domains: [] as string[], texts: [] as string[] })),
        opts.brief !== undefined ? Promise.resolve(opts.brief) : clientRawBrief(client).catch(() => null),
      ]);
      const text = await relayComplete(
        { messages: [{ role: "user", content: suggestionPrompt({ clientName: client.name, domains: signals.domains, adTexts: signals.texts, brief, known: opts.known }) }], systemPrompt: SUGGEST_SYSTEM, allowedServers: [], accountScope: {}, model: MODEL, effort: "low", maxTurns: 1 },
        { maxMs: 60_000, onUsage: (usage) => void recordAiUsage(usage, { feature: "competitors_suggest", clientName: client.name, user }) },
      );
      const names = parseSuggestions(text, client.name);
      if (names.length) await writeSetting(SUGGESTIONS_KEY(client.id), { names, at: new Date().toISOString() }, user?.id ?? null).catch(() => undefined);
      return names;
    } catch (e) {
      console.error("[competitors] suggestions impossibles", e instanceof Error ? e.message : e);
      return [];
    } finally {
      inflight.delete(client.id);
    }
  })();
  inflight.set(client.id, job);
  return job;
}

/**
 * The client's competitors. `suggest`: ask the AI when saved + HQ give fewer
 * than 3 and no fresh suggestion is cached (`"force"`: ask again anyway).
 */
export async function getClientCompetitors(client: CompetitorClient, opts: { suggest?: boolean | "force"; user?: CompetitorUser | null } = {}): Promise<ClientCompetitors> {
  const [settingJson, suggestionsJson, brief] = await Promise.all([readSetting(COMPETITORS_KEY(client.id)), readSetting(SUGGESTIONS_KEY(client.id)), clientRawBrief(client).catch(() => null)]);
  const setting = parseSetting(settingJson);
  const hq = competitorsFromBrief(brief, 6);
  let cached = parseSuggestionsSetting(suggestionsJson);
  const confirmed = mergeCompetitors({ setting, hq, suggested: [], clientName: client.name });
  let warning: string | undefined;
  const wants = needsSuggestions(confirmed) && (opts.suggest === "force" || (opts.suggest && !suggestionsFresh(cached)));
  if (wants) {
    const names = await suggestCompetitors(client, opts.user ?? null, { brief, known: confirmed.map((c) => c.name) });
    if (names.length) cached = { names, at: new Date().toISOString() };
    else warning = "L'IA n'a pas pu proposer de concurrents (relais indisponible ?).";
  }
  const suggested = needsSuggestions(confirmed) ? cached?.names ?? [] : [];
  const competitors = mergeCompetitors({ setting, hq, suggested, clientName: client.name });
  return {
    competitors, hqBrief: !!brief, suggestedAt: suggested.length ? cached?.at ?? null : null,
    needsSuggestions: needsSuggestions(confirmed) && !suggestionsFresh(cached),
    ...(warning ? { warning } : {}),
  };
}

async function editSetting(clientId: string, userId: string, edit: (s: CompetitorSetting) => CompetitorSetting): Promise<void> {
  const next = edit(parseSetting(await readSetting(COMPETITORS_KEY(clientId))));
  await writeSetting(COMPETITORS_KEY(clientId), next, userId);
}

export const addClientCompetitor = (clientId: string, name: string, userId: string) => editSetting(clientId, userId, (s) => addCompetitor(s, name));
export const removeClientCompetitor = (clientId: string, name: string, userId: string) => editSetting(clientId, userId, (s) => removeCompetitor(s, name));
