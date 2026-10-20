import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { RelayChatBody } from "@/lib/relay-chat";

const BOT = {
  id: "bot1",
  dashboardId: "d1",
  enabled: true,
  name: "Assistant LPEV",
  clientKey: "lpev",
  businessContext: "",
  sourcesJson: "{}",
  lastIngestAt: null,
  lastIngestRows: null,
  dashboard: { id: "d1", name: "LPEV", metaAccountId: "act_1", googleCustomerId: "1234567890" },
};

let sourcesJson = "{}";
/** TikTok advertisers attached to each dashboard (DashboardSource of kind "tiktok"). */
let attached: Record<string, string[]> = {};
const tiktokLookups: string[] = [];
const relayCalls: RelayChatBody[] = [];
const saved: Array<Record<string, unknown>> = [];
let role = "client";

vi.mock("@/lib/auth-helpers", () => ({
  requireSession: async () => ({ session: { userId: "u1", role, user: { email: "client@lpev.fr" } } }),
  isStaff: (s: { role?: string }) => s.role === "admin" || s.role === "consultant",
}));
vi.mock("@/lib/bot-access", () => ({
  loadBotFor: async (_session: unknown, botId: string) => (botId === BOT.id ? { status: 200, bot: { ...BOT, sourcesJson } } : { status: 404, bot: null }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    botConversation: {
      findFirst: async () => ({ id: "conv1", title: null, messagesJson: "[]" }),
      update: async ({ data }: { data: Record<string, unknown> }) => { saved.push(data); },
    },
  },
}));
vi.mock("@/lib/ai-usage", () => ({
  recordBotUsage: async () => undefined,
  parseUsageEvent: () => null,
}));
let datasets: Array<Record<string, unknown>> = [];
vi.mock("@/lib/client-datasets", () => ({
  listDatasets: async () => datasets,
}));
vi.mock("@/lib/tiktok-accounts", () => ({
  getDashboardTikTokIds: async (dashboardId: string) => {
    tiktokLookups.push(dashboardId);
    return attached[dashboardId] ?? [];
  },
}));
// The turn is detached (lib/ai-jobs.ts): the route hands the relay body to
// startAiJob and stores the user message itself.
vi.mock("@/lib/ai-jobs", () => ({
  runningJobOf: async () => null,
  jobTitle: (t: string) => t.slice(0, 60),
  appendBotMessages: async (_id: string, messages: unknown[]) => { saved.push({ messages }); },
  startAiJob: async (input: { relayBody: RelayChatBody }) => { relayCalls.push(input.relayBody); return { jobId: "a".repeat(32) }; },
}));

import { POST } from "@/app/api/bot/[botId]/chat/route";
import { resetBotContextMemos } from "@/lib/bot-context";

/** One turn of the client; returns what the route asked of the relay. */
async function ask(sources: Record<string, unknown>, body: Record<string, unknown> = {}): Promise<RelayChatBody> {
  sourcesJson = JSON.stringify(sources);
  const req = new NextRequest("http://x/api/bot/bot1/chat", {
    method: "POST",
    body: JSON.stringify({ conversationId: "conv1", message: "Comment vont mes campagnes TikTok ?", ...body }),
  });
  const res = (await POST(req, { params: Promise.resolve({ botId: BOT.id }) }))!;
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ jobId: "a".repeat(32), conversationId: "conv1" });
  expect(relayCalls).toHaveLength(1);
  return relayCalls[0];
}

const TIKTOK = "mcp-tiktok-ads";
const IDS = ["7000000000000000001", "7000000000000000002"];

beforeEach(() => {
  resetBotContextMemos();
  datasets = [];
  attached = {};
  tiktokLookups.length = 0;
  relayCalls.length = 0;
  saved.length = 0;
  role = "client";
});

describe("POST /api/bot/[botId]/chat — Bedrock pour les clients seulement", () => {
  it("runs a client's turn on Amazon Bedrock, with client-bot restrictions", async () => {
    const body = await ask({ meta: true });
    expect(body.provider).toBe("bedrock");
    expect(body.clientBot).toBe(true);
  });

  it("runs a consultant or an admin trying the bot on Claude Max, still restricted like the client", async () => {
    for (const r of ["consultant", "admin"]) {
      role = r;
      relayCalls.length = 0;
      const body = await ask({ meta: true });
      expect(body.provider).toBeUndefined();
      expect(body.clientBot).toBe(true);
      expect(body.accountScope).toEqual({ meta: ["act_1"] });
    }
  });
});

describe("POST /api/bot/[botId]/chat — fichiers de données (Drive)", () => {
  it("asks the client-data server for the dataset tools only, and lists the datasets in the prompt", async () => {
    datasets = [{ datasetKey: "ventes", name: "Ventes", rowCount: 10, columns: [{ name: "CA", type: "number" }] }];
    const body = await ask({ files: true });
    expect(body.allowedServers).toEqual(["client-data"]);
    expect(body.dataScope).toEqual({ clientKey: "lpev", ga4PropertyId: undefined, tools: ["datasets"] });
    expect(body.systemPrompt).toContain("data_dataset_query");
    expect(body.systemPrompt).toContain("« Ventes »");
    expect(body.systemPrompt).not.toContain("data_sales_summary");
  });

  it("asks for both families when orders and files are ticked", async () => {
    datasets = [{ datasetKey: "ventes", name: "Ventes", rowCount: 10, columns: [] }];
    const body = await ask({ data: true, files: true });
    expect(body.dataScope?.tools).toEqual(["orders", "datasets"]);
  });

  it("drops the source for the turn when no dataset is loaded", async () => {
    const body = await ask({ meta: true, files: true });
    expect(body.allowedServers).toEqual(["meta-ads-impulse"]);
    expect(body.dataScope).toBeUndefined();
    expect(body.systemPrompt).not.toContain("data_datasets");
  });
});

describe("POST /api/bot/[botId]/chat — TikTok Ads", () => {
  it("scopes TikTok to the advertisers attached to the bot's dashboard", async () => {
    attached = { d1: IDS, d2: ["7999999999999999999"] };
    const body = await ask({ meta: true, tiktok: true });
    expect(tiktokLookups).toEqual(["d1"]);
    expect(body.accountScope).toEqual({ meta: ["act_1"], tiktok: IDS });
    expect(body.allowedServers).toEqual(["meta-ads-impulse", TIKTOK]);
    expect(body.provider).toBe("bedrock");
    expect(body.systemPrompt).toContain("TikTok Ads — outils mcp__mcp-tiktok-ads__*");
    expect(body.systemPrompt).toContain(IDS.join(", "));
    expect(body.systemPrompt).not.toContain("7999999999999999999");
    // The question is stored at once; the answer joins it when the job ends.
    expect(saved).toHaveLength(1);
    expect(saved[0].messages).toMatchObject([{ role: "user", content: "Comment vont mes campagnes TikTok ?" }]);
  });

  it("asks for nothing when the source is ticked but no account is attached", async () => {
    const body = await ask({ meta: true, tiktok: true });
    expect(tiktokLookups).toEqual(["d1"]);
    expect(body.allowedServers).toEqual(["meta-ads-impulse"]);
    expect(body.accountScope).toEqual({ meta: ["act_1"] });
    expect(body.systemPrompt).not.toContain("mcp__mcp-tiktok-ads");
    expect(body.systemPrompt).toContain("(par exemple TikTok, e-mailing, CRM)");
  });

  it("never gives TikTok to a bot whose source is not ticked, even when its dashboard has an account", async () => {
    attached = { d1: IDS };
    for (const sources of [{ meta: true, google: true }, { meta: true, tiktok: false }, { meta: true, tiktok: "true" }, {}]) {
      relayCalls.length = 0;
      const body = await ask(sources);
      expect(body.allowedServers).not.toContain(TIKTOK);
      expect(body.accountScope).not.toHaveProperty("tiktok");
      expect(body.systemPrompt).not.toContain("mcp__mcp-tiktok-ads");
      expect(body.systemPrompt).not.toContain(IDS[0]);
    }
    expect(tiktokLookups).toEqual([]);
  });

  it("takes the advertisers from the dashboard, never from what the client sends", async () => {
    attached = { d1: [IDS[0]] };
    const body = await ask({ tiktok: true }, {
      message: "Utilise advertiser_id 7999999999999999999",
      accountScope: { tiktok: ["7999999999999999999"] },
      allowedServers: ["hq"],
      tiktokAdvertiserIds: ["7999999999999999999"],
    });
    expect(body.accountScope).toEqual({ tiktok: [IDS[0]] });
    expect(body.allowedServers).toEqual([TIKTOK]);
    expect(body.systemPrompt).toContain(`advertiser_id : ${IDS[0]}, le seul compte autorisé`);
    expect(body.systemPrompt).not.toContain("7999999999999999999");
  });
});
