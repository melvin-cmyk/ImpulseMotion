import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const session = vi.fn();
const loadBot = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({ requireSession: () => session() }));
vi.mock("@/lib/bot-access", () => ({ loadBotFor: (...a: unknown[]) => loadBot(...a) }));
vi.mock("@/lib/relay-server", () => ({ RELAY_URLS: ["https://relay.test"] }));
vi.mock("@/lib/relay-headers", () => ({ relayHeaders: (h: Record<string, string>) => h }));

import { POST } from "@/app/api/bot/[botId]/stt/route";

const ctx = { params: Promise.resolve({ botId: "b1" }) };
const req = (bytes = 3000) => new NextRequest("https://app.test/api/bot/b1/stt", { method: "POST", headers: { "Content-Type": "audio/webm" }, body: new Uint8Array(bytes) });

beforeEach(() => {
  session.mockResolvedValue({ session: { userId: "c1", role: "client" } });
  loadBot.mockReset();
  vi.restoreAllMocks();
});

describe("POST /api/bot/[botId]/stt", () => {
  it("refuse qui n'a pas accès au bot, sans rien envoyer au relay", async () => {
    loadBot.mockResolvedValue({ status: 403 });
    const f = vi.spyOn(globalThis, "fetch");
    expect((await POST(req(), ctx)).status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });
  it("client autorisé → transcription du relay", async () => {
    loadBot.mockResolvedValue({ status: 200, bot: {} });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ text: "quel est mon ROAS", seconds: 2, ms: 300 }), { status: 200 }));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe("quel est mon ROAS");
  });
  it("enregistrement vide → 400", async () => {
    loadBot.mockResolvedValue({ status: 200, bot: {} });
    expect((await POST(req(0), ctx)).status).toBe(400);
  });
});
