/**
 * AI usage ledger — what runs on Amazon Bedrock (the private client bots),
 * recorded per answered message so the agency can bill clients by usage.
 *
 * The relay ends every session with a `usage` SSE event (list-price cost,
 * tokens, turns, duration, provider, model). Only Bedrock sessions are kept:
 * everything else runs on the agency's subscription and is not billable.
 */

import { prisma } from "@/lib/prisma";

export interface RelayUsage {
  provider: string;
  model: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Reads the relay's `usage` event; null for anything else or a malformed one. */
export function parseUsageEvent(evt: unknown): RelayUsage | null {
  if (!evt || typeof evt !== "object") return null;
  const e = evt as Record<string, unknown>;
  if (e.type !== "usage") return null;
  const t = (e.tokens && typeof e.tokens === "object" ? e.tokens : {}) as Record<string, unknown>;
  return {
    provider: typeof e.provider === "string" ? e.provider : "unknown",
    model: typeof e.model === "string" ? e.model : "unknown",
    costUsd: num(e.cost),
    turns: Math.round(num(e.turns)),
    durationMs: Math.round(num(e.duration)),
    inputTokens: Math.round(num(t.input)),
    outputTokens: Math.round(num(t.output)),
    cacheReadTokens: Math.round(num(t.cacheRead)),
    cacheWriteTokens: Math.round(num(t.cacheWrite)),
  };
}

/** Writes one ledger row for a bot answer. Non-Bedrock sessions are ignored. */
export async function recordBotUsage(input: {
  usage: RelayUsage;
  bot: { id: string; clientKey: string; dashboard: { id: string; name: string } };
  user: { id: string; email?: string | null; role: string };
}): Promise<void> {
  const { usage, bot, user } = input;
  if (usage.provider !== "bedrock") return;
  await prisma.aiUsage.create({
    data: {
      provider: usage.provider,
      model: usage.model,
      feature: "client_bot",
      dashboardId: bot.dashboard.id,
      clientName: bot.dashboard.name,
      botId: bot.id,
      clientKey: bot.clientKey,
      userId: user.id,
      userEmail: user.email ?? null,
      userRole: user.role,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: usage.costUsd,
      turns: usage.turns,
      durationMs: usage.durationMs,
    },
  });
}

// ── Monthly report ───────────────────────────────────────────────────────────

export interface UsageRow {
  dashboardId: string | null;
  clientName: string;
  clientKey: string | null;
  userEmail: string | null;
  userRole: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Token counts exactly as Bedrock reports them. The four kinds are priced
 *  differently (cache writes cost more than input, cache reads far less), so
 *  they are never merged: pricing is done by the admin from these numbers. */
export interface UsageTotals {
  messages: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface ClientUsage {
  key: string;
  clientName: string;
  clientKey: string | null;
  /** Messages sent by client logins — what gets billed. */
  billable: UsageTotals;
  /** Messages sent by admins / consultants testing the bot. */
  staff: UsageTotals;
  users: Array<{ email: string; role: string } & UsageTotals>;
}

const emptyTotals = (): UsageTotals => ({ messages: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 });

export const totalTokens = (t: UsageTotals): number => t.inputTokens + t.cacheWriteTokens + t.cacheReadTokens + t.outputTokens;

function add(t: UsageTotals, r: UsageRow): void {
  t.messages += 1;
  t.inputTokens += r.inputTokens;
  t.cacheWriteTokens += r.cacheWriteTokens;
  t.cacheReadTokens += r.cacheReadTokens;
  t.outputTokens += r.outputTokens;
}

/** Groups ledger rows by client (dashboard), splitting client vs staff usage. */
export function summarizeUsage(rows: UsageRow[]): ClientUsage[] {
  const byClient = new Map<string, ClientUsage & { byUser: Map<string, { email: string; role: string } & UsageTotals> }>();
  for (const r of rows) {
    // A deleted-then-recreated dashboard keeps one line per client name.
    const key = r.dashboardId ?? `name:${r.clientName}`;
    let c = byClient.get(key);
    if (!c) {
      c = { key, clientName: r.clientName, clientKey: r.clientKey, billable: emptyTotals(), staff: emptyTotals(), users: [], byUser: new Map() };
      byClient.set(key, c);
    }
    add(r.userRole === "client" ? c.billable : c.staff, r);
    const email = r.userEmail ?? "(inconnu)";
    let u = c.byUser.get(email);
    if (!u) { u = { email, role: r.userRole, ...emptyTotals() }; c.byUser.set(email, u); }
    add(u, r);
  }
  return [...byClient.values()]
    .map(({ byUser, ...c }) => ({ ...c, users: [...byUser.values()].sort((a, b) => totalTokens(b) - totalTokens(a)) }))
    .sort((a, b) => totalTokens(b.billable) + totalTokens(b.staff) - (totalTokens(a.billable) + totalTokens(a.staff)));
}

/** "2026-09" → [start, end) in UTC; invalid or missing → the current month. */
export function monthRange(month: string | null | undefined, now = new Date()): { month: string; start: Date; end: Date } {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month ?? "");
  const y = m ? Number(m[1]) : now.getUTCFullYear();
  const mo = m ? Number(m[2]) - 1 : now.getUTCMonth();
  const start = new Date(Date.UTC(y, mo, 1));
  const end = new Date(Date.UTC(y, mo + 1, 1));
  return { month: `${y}-${String(mo + 1).padStart(2, "0")}`, start, end };
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One line per client and user — ready for a spreadsheet (";" separator, fr-FR Excel). */
export function usageCsv(month: string, clients: ClientUsage[]): string {
  const lines = [["mois", "client", "client_key", "utilisateur", "role", "facturable", "messages", "tokens_entree", "tokens_cache_ecrit", "tokens_cache_lu", "tokens_sortie"].join(";")];
  for (const c of clients) {
    for (const u of c.users) {
      lines.push([
        month, c.clientName, c.clientKey ?? "", u.email, u.role, u.role === "client" ? "oui" : "non",
        u.messages, u.inputTokens, u.cacheWriteTokens, u.cacheReadTokens, u.outputTokens,
      ].map(csvCell).join(";"));
    }
  }
  return lines.join("\n") + "\n";
}
