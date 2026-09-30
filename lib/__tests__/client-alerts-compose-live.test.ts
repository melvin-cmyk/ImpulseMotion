/**
 * Client alerts — the AI that writes an alert, asked for real. SKIPPED unless
 * CLIENT_ALERTS_LIVE=1: it reads the platforms of a real client, calls the
 * relay and costs AI tokens.
 *
 * One run = ONE turn of one conversation. The body is built exactly as
 * app/api/client-alerts/[id]/assistant/route.ts builds it (buildAlertRelayBody:
 * same system prompt, same profile, no server, the real figures of the client
 * read by readClientSeries and written by summarizeSeries); the reply is
 * checked as the route checks it (checkAlertProposal + validateAlertProposal,
 * then backtest over the last 30 days and replayVerdict). Nothing is activated and nothing is
 * saved anywhere but the transcript, kept in a local file so that the next
 * turn can answer what the AI asked.
 *
 * Read-only by construction: the database goes through a guard that refuses
 * every write but the cache of the series (KpiCache, ten minutes — what
 * readClientSeries does in production too), and the Slack webhooks are taken
 * out of the environment before anything is loaded.
 *
 *   ( set -a; . /etc/impulsemotion-relay.env; . ./.env.local; set +a; \
 *     CLIENT_ALERTS_LIVE=1 CLIENT_ALERTS_LIVE_CLIENT="LPEV" CLIENT_ALERTS_LIVE_EXAMPLE=cpa \
 *     CLIENT_ALERTS_LIVE_MESSAGE="Préviens-moi si le CPA dépasse un niveau anormal sur 3 jours" \
 *     npx vitest run lib/__tests__/client-alerts-compose-live.test.ts )
 *
 *   CLIENT_ALERTS_LIVE_CLIENT    name or id of an AlertClient (its accounts are those of the conversation)
 *   CLIENT_ALERTS_LIVE_EXAMPLE   name of the conversation (one transcript per name)
 *   CLIENT_ALERTS_LIVE_MESSAGE   what the consultant says at this turn
 *   CLIENT_ALERTS_LIVE_NOTE      optional: what happened to the previous proposal, sent as the interface sends it
 *   CLIENT_ALERTS_LIVE_DIR       where the transcripts are kept (default: the system's temporary directory)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { parseUsageEvent, type RelayUsage } from "@/lib/ai-usage";
import type { AlertAccountRef, AlertDefinition } from "@/lib/client-alerts/types";

const LIVE = process.env.CLIENT_ALERTS_LIVE === "1";

// No private message can leave from here, whatever the environment was loaded with.
if (LIVE) for (const key of ["N8N_DM_WEBHOOK_URL", "N8N_ALERT_WEBHOOK_URL", "N8N_ALERT_WEBHOOK_SECRET", "CLIENT_ALERTS_SEND"]) delete process.env[key];

/**
 * The real database, read-only: every read goes through, every write is
 * refused — but the cache of the series, which is what production writes when
 * it reads the same figures. Built on first use: a skipped run loads nothing.
 */
vi.mock("@/lib/prisma", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const real = new PrismaClient({ log: ["error"] });
  const READS = new Set(["findMany", "findFirst", "findUnique", "findFirstOrThrow", "findUniqueOrThrow", "count", "aggregate", "groupBy"]);
  const CACHE = "kpiCache";
  const refused = (what: string) => async () => { throw new Error(`essai en lecture seule : ${what} refusé`); };
  const model = (name: string, target: Record<string, unknown>) => new Proxy(target, {
    get(t, op) {
      const value = t[op as string];
      if (typeof op !== "string" || typeof value !== "function") return value;
      return READS.has(op) || name === CACHE ? value.bind(t) : refused(`${name}.${op}`);
    },
  });
  const prisma = new Proxy(real as unknown as Record<string, unknown>, {
    get(t, prop) {
      const value = t[prop as string];
      if (typeof prop !== "string") return value;
      if (prop === "$disconnect" || prop === "$connect") return (value as () => Promise<void>).bind(t);
      // Raw queries and transactions could write: none is needed to read a series.
      if (prop.startsWith("$")) return refused(prop);
      return value && typeof value === "object" ? model(prop, value as Record<string, unknown>) : value;
    },
  });
  return { prisma };
});

interface Turn {
  user: string;
  assistant: string;
  durationMs: number;
  usage: RelayUsage | null;
  errors: string[];
  proposal: "none" | "valid" | "invalid";
  validationErrors: string[];
  hints: string[];
  warnings: string[];
  definition: AlertDefinition | null;
  /** Replay over the last 30 days, as the card shows it; null without a valid proposal, or when an account was unreadable. */
  replay: { messages: string[]; daysTrue: number; skippedDays: number; current: number | null; min: number | null; median: number | null; max: number | null; notes: string[] } | null;
  /** The two lines of totals the AI read (7 and 30 days): what a threshold is judged against. */
  figures: string[];
}
interface Transcript { alertId: string; client: string; messages: Array<{ role: "user" | "assistant"; content: string }>; turns: Turn[] }

/** Reads the relay's stream to its end: text, last usage, errors. */
async function readStream(res: Response): Promise<Pick<Turn, "assistant" | "usage" | "errors">> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: RelayUsage | null = null;
  const errors: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      let evt: Record<string, unknown>;
      try { evt = JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>; } catch { continue; }
      if (evt.type === "delta" && typeof evt.text === "string") text += evt.text;
      else if (evt.type === "content" && typeof evt.text === "string" && !text) text = evt.text;
      else if (evt.type === "error" && typeof evt.message === "string") errors.push(evt.message);
      else if (evt.type === "usage") usage = parseUsageEvent(evt) ?? usage;
    }
  }
  return { assistant: text.trim(), usage, errors };
}

describe.skipIf(!LIVE)("alertes client — l'IA de création, en vrai (CLIENT_ALERTS_LIVE=1)", () => {
  it("un tour de conversation : la réponse est lue, validée et rejouée comme le fait la route", async () => {
    const example = (process.env.CLIENT_ALERTS_LIVE_EXAMPLE ?? "").replace(/[^a-z0-9_-]/gi, "");
    const said = (process.env.CLIENT_ALERTS_LIVE_MESSAGE ?? "").trim();
    const wanted = (process.env.CLIENT_ALERTS_LIVE_CLIENT ?? "").trim();
    expect(example, "CLIENT_ALERTS_LIVE_EXAMPLE manquant").not.toBe("");
    expect(said, "CLIENT_ALERTS_LIVE_MESSAGE manquant").not.toBe("");
    expect(wanted, "CLIENT_ALERTS_LIVE_CLIENT manquant").not.toBe("");
    expect(process.env.RELAY_SHARED_SECRET, "secret du relay absent de l'environnement").toBeTruthy();
    expect(process.env.DATABASE_URL, "base absente de l'environnement (.env.local)").toBeTruthy();

    // Loaded here, not at the top: a skipped run opens neither the database nor the platforms.
    const { prisma } = await import("@/lib/prisma");
    const { parseAccounts } = await import("@/lib/auto-alerts/clients");
    const { sanitizeThread, toRelayMessages } = await import("@/lib/relay-attachments");
    const { relayStream } = await import("@/lib/relay-chat");
    const { readClientSeries, summarizeSeries } = await import("@/lib/client-alerts/series");
    const { backtest, replayVerdict } = await import("@/lib/client-alerts/backtest");
    const { validateAlertProposal } = await import("@/lib/client-alerts/validate");
    const {
      ALERT_CHAT_MAX_MESSAGES, ALERT_CHAT_MAX_MESSAGE_CHARS, buildAlertRelayBody, checkAlertProposal, stripAlertBlocks, withProposalNotes,
    } = await import("@/lib/client-alerts/compose-prompt");
    const { CLIENT_ALERT_COMPOSE_PROFILE } = await import("@/lib/ai-profiles");

    const client = await prisma.alertClient.findFirst({
      where: { gone: false, OR: [{ id: wanted }, { name: wanted }] },
      select: { id: true, name: true, accountsJson: true },
    });
    expect(client, `client « ${wanted} » introuvable`).not.toBeNull();
    const accounts: AlertAccountRef[] = parseAccounts(client!.accountsJson);
    expect(accounts.length, "client sans compte").toBeGreaterThan(0);

    const dir = process.env.CLIENT_ALERTS_LIVE_DIR || path.join(tmpdir(), "client-alerts-live");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${example}.json`);
    const transcript: Transcript = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Transcript)
      : { alertId: `live${Date.now().toString(36)}${example}`.slice(0, 40), client: client!.name, messages: [], turns: [] };
    expect(transcript.client, "cette conversation a commencé avec un autre client").toBe(client!.name);

    // As the route: the figures are read once, and the AI is told when there are none.
    const series = await readClientSeries(accounts);
    const readable = series.accounts.some((a) => !a.error && a.days.length > 0);
    const summary = readable ? summarizeSeries(series) : null;
    const figures = (summary ?? "").split("\n").filter((l) => /^(7|30) derniers jours/.test(l));

    // As the interface does: what happened to the last proposal travels with the next message.
    const note = (process.env.CLIENT_ALERTS_LIVE_NOTE ?? "").trim();
    const content = withProposalNotes(note ? [note] : [], said);
    const thread = sanitizeThread([...transcript.messages, { role: "user", content }], { maxMessages: ALERT_CHAT_MAX_MESSAGES, maxChars: ALERT_CHAT_MAX_MESSAGE_CHARS });
    expect(thread).not.toBeNull();

    const body = buildAlertRelayBody({
      alert: { id: transcript.alertId, status: "draft" },
      clientName: client!.name,
      accounts,
      seriesSummary: summary,
      current: null,
      userId: "essai-integration",
      author: "essai@impulse-analytics.com",
      messages: toRelayMessages(thread!.map((m) => ({ role: m.role, content: m.content }))),
    });
    // What the route guarantees, whatever the conversation says.
    expect(body.allowedServers).toEqual([]);
    expect(body.accountScope).toEqual({});
    expect(body.model).toBe(CLIENT_ALERT_COMPOSE_PROFILE.model);
    expect(body.turnContext.length).toBeLessThanOrEqual(20_000);

    const started = Date.now();
    const res = await relayStream(body);
    expect(res.ok, `relay ${res.status}`).toBe(true);
    const read = await readStream(res);
    const durationMs = Date.now() - started;

    const check = checkAlertProposal(read.assistant, (input) => validateAlertProposal(input, { accounts, series }));
    let replay: Turn["replay"] = null;
    let verdict = "";
    if (check.kind === "valid") {
      const b = backtest(check.proposal, series);
      // As the route: a replay that judged (almost) nothing is not a measure — the proposal waits, or is refused.
      const v = replayVerdict(check.proposal, series, b);
      verdict = v.kind === "ok" ? "" : v.kind === "wait" ? "rejeu en attente : compte illisible" : `rejeu refusé : ${v.error}`;
      replay = { messages: b.messages.map((m) => m.date), daysTrue: b.daysTrue, skippedDays: b.skippedDays, current: b.current, min: b.min, median: b.median, max: b.max, notes: b.notes };
    }
    const turn: Turn = {
      user: content, ...read, durationMs,
      proposal: check.kind,
      validationErrors: check.kind === "invalid" ? check.errors : verdict ? [verdict] : [],
      hints: check.kind === "invalid" ? check.hints : [],
      warnings: check.kind === "valid" ? check.warnings : [],
      definition: check.kind === "valid" ? check.proposal : null,
      replay,
      figures,
    };
    transcript.messages.push({ role: "user", content }, { role: "assistant", content: read.assistant });
    transcript.turns.push(turn);
    writeFileSync(file, JSON.stringify(transcript, null, 1));

    const u = read.usage;
    const d = turn.definition;
    const blocks = (read.assistant.match(/```alert\b/gi) ?? []).length;
    console.log([
      `── ${example} · ${client!.name} · tour ${transcript.turns.length} · ${Math.round(durationMs / 1000)} s · ${u ? `${u.model} entrée ${u.inputTokens} sortie ${u.outputTokens} cache lu ${u.cacheReadTokens} écrit ${u.cacheWriteTokens} · ${u.turns} appel(s) · ${u.costUsd.toFixed(3)} $` : "consommation inconnue"}`,
      `contexte : ${body.turnContext.length} caractères · comptes : ${series.accounts.map((a) => `${a.account.platform}${a.error ? " illisible" : ""}`).join(", ")}`,
      ...figures,
      read.errors.length ? `erreurs du relay : ${read.errors.join(" | ")}` : "",
      `blocs alert : ${blocks} · proposition : ${check.kind}${turn.validationErrors.length ? ` — ${turn.validationErrors.join(" | ")}` : ""}`,
      d ? `règle : ${d.metric} ${d.condition} ${d.threshold ?? "—"} sur ${d.windowDays} j · ${d.aggregation} · compare ${d.compare} · gardes ${JSON.stringify(d.guards)} · ${d.checks} · silence ${d.cooldownHours} h · rappel ${d.remind} · semaine seule ${d.weekdaysOnly} · comptes ${d.accounts.length}/${accounts.length}` : "",
      turn.warnings.length ? `avertissements : ${turn.warnings.join(" | ")}` : "",
      replay ? `rejeu 30 j : ${replay.messages.length} message(s)${replay.messages.length ? ` (${replay.messages.join(", ")})` : ""} · ${replay.daysTrue} jour(s) vrai(s) · ${replay.skippedDays} non jugé(s) · actuel ${replay.current ?? "—"} · min ${replay.min ?? "—"} · médiane ${replay.median ?? "—"} · max ${replay.max ?? "—"}` : "",
      replay?.notes.length ? `notes du rejeu : ${replay.notes.join(" | ")}` : "",
      "",
      stripAlertBlocks(read.assistant),
      check.kind !== "none" ? `\n[bloc alert]\n${/```alert[\s\S]*?```/i.exec(read.assistant)?.[0] ?? ""}` : "",
    ].filter((l) => l !== "").join("\n"));

    await prisma.$disconnect();
    expect(read.assistant, "réponse vide").not.toBe("");
  }, 330_000);
});
