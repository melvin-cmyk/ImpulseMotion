/**
 * lib/ai-jobs.ts with a stand-in for Prisma and the relay: a job ends once
 * (the first claimer writes the answer and the ledger line), the surfaces get
 * their message shape, lost jobs are given up after a while.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type JobRow = { id: string; userId: string; surface: string; conversationId: string; botId: string | null; status: string; title: string; userMessageJson: string; usageContextJson: string; error: string | null; startedAt: Date; finishedAt: Date | null };
const jobs = new Map<string, JobRow>();
const botThreads = new Map<string, { title: string | null; messagesJson: string }>();
const consoleThreads = new Map<string, { userId: string; title: string; messagesJson: string }>();
const ledger: unknown[] = [];
let relayStates: Record<string, unknown> = {};
let detachResult: { jobId: string } | { error: string } = { jobId: "b".repeat(32) };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    aiJob: {
      create: async ({ data }: { data: Partial<JobRow> }) => { jobs.set(data.id!, { botId: null, status: "running", title: "", userMessageJson: "{}", usageContextJson: "{}", error: null, startedAt: new Date(), finishedAt: null, ...data } as JobRow); },
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Partial<JobRow> }) => {
        const j = jobs.get(where.id);
        if (!j || j.status !== where.status) return { count: 0 };
        Object.assign(j, data);
        return { count: 1 };
      },
      findUnique: async ({ where }: { where: { id: string } }) => jobs.get(where.id) ?? null,
      findFirst: async ({ where }: { where: { id?: string; conversationId?: string; userId: string; status?: string } }) =>
        [...jobs.values()].find((j) => (!where.id || j.id === where.id) && (!where.conversationId || j.conversationId === where.conversationId) && j.userId === where.userId && (!where.status || j.status === where.status)) ?? null,
      findMany: async ({ where }: { where: { userId?: string; conversationId?: { in: string[] }; status?: string } }) =>
        [...jobs.values()].filter((j) => (!where.userId || j.userId === where.userId) && (!where.conversationId || where.conversationId.in.includes(j.conversationId)) && (!where.status || j.status === where.status)),
    },
    botConversation: {
      findUnique: async ({ where }: { where: { id: string } }) => botThreads.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<{ title: string; messagesJson: string }> }) => { Object.assign(botThreads.get(where.id)!, data); },
    },
    consoleConversation: {
      findUnique: async ({ where }: { where: { id: string } }) => consoleThreads.get(where.id) ?? null,
      create: async ({ data }: { data: { id: string; userId: string; title: string; messagesJson: string } }) => { consoleThreads.set(data.id, data); },
      update: async ({ where, data }: { where: { id: string }; data: Partial<{ title: string; messagesJson: string }> }) => { Object.assign(consoleThreads.get(where.id)!, data); },
    },
  },
}));
vi.mock("@/lib/ai-usage", async (original) => {
  const real = await original<typeof import("@/lib/ai-usage")>();
  return { ...real, recordAiUsage: async (usage: unknown, ctx: unknown) => { ledger.push({ usage, ctx }); } };
});
vi.mock("@/lib/relay-chat", () => ({
  relayDetach: async () => detachResult,
  relayJobState: async (id: string) => (id in relayStates ? { state: relayStates[id] } : { missing: true }),
  relayJobStop: async (id: string) => (id in relayStates ? { stopped: true, status: "stopped" } : { missing: true }),
}));

import { finalizeAiJob, listJobs, reconcileJob, runningConversationIds, startAiJob } from "@/lib/ai-jobs";

const usage = { provider: "subscription", model: "sonnet", effort: null, costUsd: 0.01, turns: 1, durationMs: 100, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const summary = (text: string) => ({ text, sawDone: true, usage, toolCalls: [{ name: "mcp__hq__read", id: "t1" }], error: null, resumable: false });
const ctx = { feature: "client_bot" as const, clientName: "LPEV", user: { id: "u1", role: "client" } };

beforeEach(() => {
  jobs.clear(); botThreads.clear(); consoleThreads.clear(); ledger.length = 0; relayStates = {};
  detachResult = { jobId: "b".repeat(32) };
  botThreads.set("conv1", { title: null, messagesJson: JSON.stringify([{ role: "user", content: "Bonjour ?", at: "2026-10-20T00:00:00.000Z" }]) });
});

describe("startAiJob", () => {
  it("records the relay job with the ledger context", async () => {
    const r = await startAiJob({ relayBody: { messages: [] }, surface: "bot", userId: "u1", conversationId: "conv1", botId: "bot1", title: "Bonjour ? ".repeat(20), usageContext: ctx });
    expect(r).toEqual({ jobId: "b".repeat(32) });
    const row = jobs.get("b".repeat(32))!;
    expect(row).toMatchObject({ surface: "bot", conversationId: "conv1", botId: "bot1", status: "running" });
    expect(row.title.length).toBeLessThanOrEqual(60);
    expect(JSON.parse(row.usageContextJson)).toEqual(ctx);
    expect(await runningConversationIds(["conv1", "x"], "u1")).toEqual(new Map([["conv1", "b".repeat(32)]]));
  });
  it("records nothing when the relay refuses", async () => {
    detachResult = { error: "IA indisponible" };
    expect(await startAiJob({ relayBody: { messages: [] }, surface: "bot", userId: "u1", conversationId: "conv1", title: "x", usageContext: ctx })).toEqual({ error: "IA indisponible" });
    expect(jobs.size).toBe(0);
  });
});

describe("finalizeAiJob", () => {
  it("writes the bot answer and the ledger line once; a second caller does nothing", async () => {
    await startAiJob({ relayBody: { messages: [] }, surface: "bot", userId: "u1", conversationId: "conv1", botId: "bot1", title: "Bonjour ?", usageContext: ctx });
    const first = await finalizeAiJob("b".repeat(32), summary("Bonjour !"));
    expect(first).toMatchObject({ finalized: true, status: "done" });
    const second = await finalizeAiJob("b".repeat(32), summary("Autre"));
    expect(second).toMatchObject({ finalized: false, status: "done" });
    const msgs = JSON.parse(botThreads.get("conv1")!.messagesJson) as Array<{ role: string; content: string }>;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].content).toBe("Bonjour !");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ ctx });
  });

  it("gives the console its message shape (tool calls, usage) and creates the thread if needed", async () => {
    await startAiJob({ relayBody: { messages: [] }, surface: "console", userId: "u1", conversationId: "c-1", title: "Analyse", usageContext: { feature: "console", clientName: "—", user: { id: "u1", role: "consultant" } } });
    await finalizeAiJob("b".repeat(32), summary("Voici l'analyse."));
    const row = consoleThreads.get("c-1")!;
    const msgs = JSON.parse(row.messagesJson) as Array<Record<string, unknown>>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: "assistant", content: "Voici l'analyse.", toolCalls: [{ name: "mcp__hq__read", id: "t1" }], usage: { cost: 0.01, turns: 1, duration: 100 } });
  });

  it("records a failure when nothing usable came back, and a stop as such", async () => {
    await startAiJob({ relayBody: { messages: [] }, surface: "bot", userId: "u1", conversationId: "conv1", botId: "bot1", title: "x", usageContext: ctx });
    const r = await finalizeAiJob("b".repeat(32), { ...summary(""), error: "Claude exited with code 1", usage: null });
    expect(r.status).toBe("failed");
    const msgs = JSON.parse(botThreads.get("conv1")!.messagesJson) as Array<{ content: string }>;
    expect(msgs[1].content).toContain("n'a pas pu répondre");
    expect(msgs[1].content).toContain("Claude exited with code 1");
    expect(ledger).toHaveLength(0);

    detachResult = { jobId: "c".repeat(32) };
    await startAiJob({ relayBody: { messages: [] }, surface: "bot", userId: "u1", conversationId: "conv1", botId: "bot1", title: "x", usageContext: ctx });
    const s = await finalizeAiJob("c".repeat(32), summary("Début de réponse"), { relayStatus: "stopped" });
    expect(s.status).toBe("stopped");
    expect((JSON.parse(botThreads.get("conv1")!.messagesJson) as Array<{ content: string }>).at(-1)!.content).toContain("arrêtée");
  });
});

describe("reconcileJob / listJobs", () => {
  it("leaves a young job alone, ends one the relay reports done, gives up a lost one after a while", async () => {
    await startAiJob({ relayBody: { messages: [] }, surface: "bot", userId: "u1", conversationId: "conv1", botId: "bot1", title: "x", usageContext: ctx });
    const id = "b".repeat(32);
    const row = jobs.get(id)!;
    const young = await reconcileJob({ ...row, surface: "bot", status: "running" } as never);
    expect(young.status).toBe("running");

    row.startedAt = new Date(Date.now() - 60_000);
    relayStates[id] = { id, status: "done", text: "Fini.", sawDone: true, usage: { type: "usage", cost: 0.02, provider: "subscription", model: "sonnet", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }, toolCalls: [], error: null, resumable: false };
    const { running, finished } = await listJobs("u1");
    expect(running).toEqual([]);
    expect(finished[0]).toMatchObject({ id, status: "done" });
    expect((JSON.parse(botThreads.get("conv1")!.messagesJson) as Array<{ content: string }>).at(-1)!.content).toBe("Fini.");
    expect(ledger).toHaveLength(1);

    detachResult = { jobId: "d".repeat(32) };
    await startAiJob({ relayBody: { messages: [] }, surface: "bot", userId: "u1", conversationId: "conv1", botId: "bot1", title: "x", usageContext: ctx });
    const lost = jobs.get("d".repeat(32))!;
    lost.startedAt = new Date(Date.now() - 60_000);
    expect((await reconcileJob({ ...lost, surface: "bot", status: "running" } as never)).status).toBe("running"); // relay unknown but recent
    lost.startedAt = new Date(Date.now() - 10 * 60_000);
    const gone = await reconcileJob({ ...lost, surface: "bot", status: "running" } as never);
    expect(gone.status).toBe("failed");
    expect(gone.error).toContain("redémarré");
  });
});
