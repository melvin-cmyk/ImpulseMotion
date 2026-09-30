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

vi.mock("@/lib/auth-helpers", () => ({
  requireSession: async () => ({ session: { userId: "u1", role: "client", user: { email: "client@lpev.fr" } } }),
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
vi.mock("@/lib/tiktok-accounts", () => ({
  getDashboardTikTokIds: async (dashboardId: string) => {
    tiktokLookups.push(dashboardId);
    return attached[dashboardId] ?? [];
  },
}));
vi.mock("@/lib/relay-chat", async (original) => {
  const real = await original<typeof import("@/lib/relay-chat")>();
  return {
    ...real,
    relayStream: async (body: RelayChatBody) => {
      relayCalls.push(body);
      const sse = ['data: {"type":"delta","text":"Bonjour"}', 'data: {"type":"done"}', ""].join("\n\n");
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  };
});

import { POST } from "@/app/api/bot/[botId]/chat/route";

/** One turn of the client; returns what the route asked of the relay. */
async function ask(sources: Record<string, unknown>, body: Record<string, unknown> = {}): Promise<RelayChatBody> {
  sourcesJson = JSON.stringify(sources);
  const req = new NextRequest("http://x/api/bot/bot1/chat", {
    method: "POST",
    body: JSON.stringify({ conversationId: "conv1", message: "Comment vont mes campagnes TikTok ?", ...body }),
  });
  const res = (await POST(req, { params: Promise.resolve({ botId: BOT.id }) }))!;
  expect(res.status).toBe(200);
  await res.text();
  expect(relayCalls).toHaveLength(1);
  return relayCalls[0];
}

const TIKTOK = "mcp-tiktok-ads";
const IDS = ["7000000000000000001", "7000000000000000002"];

beforeEach(() => {
  attached = {};
  tiktokLookups.length = 0;
  relayCalls.length = 0;
  saved.length = 0;
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
    // The turn is stored as usual.
    expect(saved).toHaveLength(1);
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
