/**
 * Routines — the AI that writes a routine, asked for real. SKIPPED unless
 * ROUTINES_LIVE=1: it calls the relay (read-only tools) and costs AI tokens.
 *
 * One run = ONE turn of one conversation. The body is built exactly as
 * app/api/routines/[id]/assistant/route.ts builds it (same system prompt, same
 * servers, same profile, same account scope); the reply is checked as the route
 * checks it (one ```routine block, validateProposal). Nothing is applied and
 * nothing is written anywhere but the transcript, kept in a local file so the
 * next turn can answer what the AI asked.
 *
 *   ( set -a; . /etc/impulsemotion-relay.env; set +a; \
 *     ROUTINES_LIVE=1 ROUTINES_LIVE_EXAMPLE=creas ROUTINES_LIVE_MESSAGE="…" \
 *     DATABASE_URL="postgresql://x:x@127.0.0.1:1/x" \
 *     npx vitest run lib/__tests__/routines-compose-live.test.ts )
 *
 *   ROUTINES_LIVE_EXAMPLE   name of the conversation (one transcript per name)
 *   ROUTINES_LIVE_MESSAGE   what the consultant says at this turn
 *   ROUTINES_LIVE_NOTE      optional: what happened to the previous proposal, sent as the interface sends it
 *   ROUTINES_LIVE_DIR       where the transcripts are kept (default: the system's temporary directory)
 *   ROUTINES_LIVE_META, ROUTINES_LIVE_GOOGLE   accounts of the routine
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseUsageEvent, type RelayUsage } from "@/lib/ai-usage";
import { sanitizeThread, toRelayMessages } from "@/lib/relay-attachments";
import { relayStream } from "@/lib/relay-chat";
import {
  ROUTINE_CHAT_MAX_MESSAGES, ROUTINE_CHAT_MAX_MESSAGE_CHARS, ROUTINE_COMPOSE_SERVERS,
  buildRoutineRelayBody, checkRoutineProposal, stripRoutineBlocks, type ProposalValidator, type RoutineForPrompt,
} from "@/lib/routines/compose-prompt";
import { validateProposal } from "@/lib/routines/validate";

const LIVE = process.env.ROUTINES_LIVE === "1";

interface Turn {
  user: string;
  assistant: string;
  durationMs: number;
  usage: RelayUsage | null;
  tools: string[];
  errors: string[];
  proposal: "none" | "valid" | "invalid";
  validationErrors: string[];
  steps: string[];
}
interface Transcript { routineId: string; messages: Array<{ role: "user" | "assistant"; content: string }>; turns: Turn[] }

const validator: ProposalValidator = (input) => {
  const result = validateProposal(input);
  return result.ok ? { ok: true, proposal: result.value } : { ok: false, errors: result.errors };
};

/** Reads the relay's stream to its end: text, last usage, tools called, errors. */
async function readStream(res: Response): Promise<Pick<Turn, "assistant" | "usage" | "tools" | "errors">> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: RelayUsage | null = null;
  const tools: string[] = [];
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
      else if (evt.type === "activity" || evt.type === "tool" || evt.type === "tool_use") {
        const name = [evt.tool, evt.name, evt.label, evt.step].find((v) => typeof v === "string" && v);
        if (typeof name === "string" && tools[tools.length - 1] !== name) tools.push(name);
      }
    }
  }
  return { assistant: text.trim(), usage, tools, errors };
}

describe.skipIf(!LIVE)("routines — l'IA de création, en vrai (ROUTINES_LIVE=1)", () => {
  it("un tour de conversation : la réponse est lue et la proposition validée comme le fait la route", async () => {
    const example = (process.env.ROUTINES_LIVE_EXAMPLE ?? "").replace(/[^a-z0-9_-]/gi, "");
    const said = (process.env.ROUTINES_LIVE_MESSAGE ?? "").trim();
    expect(example, "ROUTINES_LIVE_EXAMPLE manquant").not.toBe("");
    expect(said, "ROUTINES_LIVE_MESSAGE manquant").not.toBe("");
    expect(process.env.RELAY_SHARED_SECRET, "secret du relay absent de l'environnement").toBeTruthy();

    const dir = process.env.ROUTINES_LIVE_DIR || path.join(tmpdir(), "routines-live");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${example}.json`);
    const transcript: Transcript = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as Transcript)
      : { routineId: `live${Date.now().toString(36)}${example}`.slice(0, 40), messages: [], turns: [] };

    const routine: RoutineForPrompt = {
      id: transcript.routineId,
      name: "Nouvelle routine",
      clientName: process.env.ROUTINES_LIVE_CLIENT || "Compte de recette",
      status: "draft",
      metaAccountId: process.env.ROUTINES_LIVE_META || "act_564381881705822",
      googleCustomerId: process.env.ROUTINES_LIVE_GOOGLE || "4768893847",
      timezone: "Europe/Paris",
      maxItemsPerRun: 20,
      definitionJson: "{}",
      scheduleJson: "{}",
      definitionHash: "",
      dryRunHash: null,
    };

    // As the interface does: what happened to the last proposal travels with the next message.
    const note = (process.env.ROUTINES_LIVE_NOTE ?? "").trim();
    const content = note ? `[Résultat des propositions précédentes : ${note}]\n\n${said}` : said;
    const thread = sanitizeThread([...transcript.messages, { role: "user", content }], { maxMessages: ROUTINE_CHAT_MAX_MESSAGES, maxChars: ROUTINE_CHAT_MAX_MESSAGE_CHARS });
    expect(thread).not.toBeNull();

    const body = buildRoutineRelayBody({ routine, userId: "essai-integration", author: "essai@impulse-analytics.com", messages: toRelayMessages(thread!) });
    // What the route guarantees, whatever the conversation says.
    expect(body.allowedServers).toEqual([...ROUTINE_COMPOSE_SERVERS]);
    expect(body.accountScope).toEqual({ meta: [routine.metaAccountId!.replace(/^act_/, "")], google: [routine.googleCustomerId] });

    const started = Date.now();
    const res = await relayStream(body);
    expect(res.ok, `relay ${res.status}`).toBe(true);
    const read = await readStream(res);
    const durationMs = Date.now() - started;

    const check = checkRoutineProposal(read.assistant, validator);
    const turn: Turn = {
      user: content, ...read, durationMs,
      proposal: check.kind,
      validationErrors: check.kind === "invalid" ? check.errors : [],
      steps: check.kind === "valid" ? check.proposal.definition.steps.map((s) => `${s.id}:${s.type}`) : [],
    };
    transcript.messages.push({ role: "user", content }, { role: "assistant", content: read.assistant });
    transcript.turns.push(turn);
    writeFileSync(file, JSON.stringify(transcript, null, 1));

    const u = read.usage;
    console.log([
      `── ${example} · tour ${transcript.turns.length} · ${Math.round(durationMs / 1000)} s · ${u ? `${u.model} entrée ${u.inputTokens} sortie ${u.outputTokens} cache lu ${u.cacheReadTokens} écrit ${u.cacheWriteTokens} · ${u.turns} appel(s) · ${u.costUsd.toFixed(3)} $` : "consommation inconnue"}`,
      read.tools.length ? `outils : ${read.tools.join(" → ")}` : "outils : aucun",
      read.errors.length ? `erreurs du relay : ${read.errors.join(" | ")}` : "",
      `proposition : ${check.kind}${turn.validationErrors.length ? ` — ${turn.validationErrors.join(" | ")}` : ""}${turn.steps.length ? ` — ${turn.steps.join(", ")}` : ""}`,
      "",
      stripRoutineBlocks(read.assistant),
      check.kind !== "none" ? `\n[bloc routine]\n${/```routine[\s\S]*?```/.exec(read.assistant)?.[0] ?? ""}` : "",
    ].filter((l) => l !== "").join("\n"));

    expect(read.assistant, "réponse vide").not.toBe("");
  }, 330_000);
});
