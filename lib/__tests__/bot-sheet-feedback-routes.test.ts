import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const session = vi.fn();
const loadBot = vi.fn();
const createSheet = vi.fn();
const ensureSub = vi.fn();
const share = vi.fn();
const fbCount = vi.fn();
const fbCreate = vi.fn();
const convFind = vi.fn();
vi.mock("@/lib/auth-helpers", () => ({ requireSession: () => session(), isStaff: (s: { role?: string }) => s?.role === "admin" || s?.role === "consultant" }));
vi.mock("@/lib/bot-access", () => ({ loadBotFor: (...a: unknown[]) => loadBot(...a) }));
vi.mock("@/lib/clients/drive", () => ({ createSheetFromRows: (...a: unknown[]) => createSheet(...a), ensureClientSubfolder: (...a: unknown[]) => ensureSub(...a), shareFile: (...a: unknown[]) => share(...a) }));
vi.mock("@/lib/prisma", () => ({ prisma: { botFeedback: { count: (...a: unknown[]) => fbCount(...a), create: (...a: unknown[]) => fbCreate(...a) }, botConversation: { findFirst: (...a: unknown[]) => convFind(...a) } } }));

import { POST as sheetPOST } from "@/app/api/bot/[botId]/sheet/route";
import { POST as feedbackPOST } from "@/app/api/bot/[botId]/feedback/route";

const ctx = { params: Promise.resolve({ botId: "b1" }) };
const req = (body: unknown) => new NextRequest("https://app.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const BOT = { status: 200, bot: { id: "b1", dashboard: { id: "d1", name: "Decathlon Travel" } } };

beforeEach(() => {
  for (const m of [session, loadBot, createSheet, ensureSub, share, fbCount, fbCreate, convFind]) m.mockReset();
  session.mockResolvedValue({ session: { userId: "c1", role: "client", user: { email: "client@marque.fr" } } });
});

describe("POST /api/bot/[botId]/sheet", () => {
  it("refuse qui n'a pas accès au bot", async () => {
    loadBot.mockResolvedValue({ status: 403 });
    expect((await sheetPOST(req({ columns: ["a"], rows: [["1"]] }), ctx)).status).toBe(403);
    expect(createSheet).not.toHaveBeenCalled();
  });
  it("client : feuille dans « Tableaux » du client, partagée avec lui", async () => {
    loadBot.mockResolvedValue(BOT);
    ensureSub.mockResolvedValue({ id: "folder1" });
    createSheet.mockResolvedValue({ id: "sheet1", webViewLink: "https://docs.google.com/spreadsheets/d/sheet1/edit" });
    share.mockResolvedValue({ shared: true, notified: false });
    const res = await sheetPOST(req({ title: "Chiffres Meta", columns: ["Indicateur", "7 jours"], rows: [["Impressions", "1 982 970"]] }), ctx);
    expect(res.status).toBe(200);
    expect(ensureSub).toHaveBeenCalledWith("d1", "tables");
    expect(createSheet.mock.calls[0][2]).toEqual(["Indicateur", "7 jours"]);
    expect(createSheet.mock.calls[0][3]).toEqual([["Impressions", 1982970]]);
    expect(share).toHaveBeenCalledWith("sheet1", "client@marque.fr", expect.objectContaining({ role: "writer" }));
    expect((await res.json()).url).toContain("sheet1");
  });
  it("staff : pas de partage individuel", async () => {
    session.mockResolvedValue({ session: { userId: "s1", role: "consultant", user: { email: "c@impulse-analytics.com" } } });
    loadBot.mockResolvedValue(BOT);
    ensureSub.mockResolvedValue({ id: "folder1" });
    createSheet.mockResolvedValue({ id: "sheet1", webViewLink: null });
    expect((await sheetPOST(req({ columns: ["a"], rows: [["1"]] }), ctx)).status).toBe(200);
    expect(share).not.toHaveBeenCalled();
  });
});

describe("POST /api/bot/[botId]/feedback", () => {
  it("enregistre un avis, conversation gardée seulement si c'est la sienne", async () => {
    loadBot.mockResolvedValue(BOT);
    fbCount.mockResolvedValue(0);
    convFind.mockResolvedValue(null);
    const res = await feedbackPOST(req({ message: "Il manque TikTok", rating: "down", conversationId: "autre" }), ctx);
    expect(res.status).toBe(200);
    expect(fbCreate.mock.calls[0][0].data).toMatchObject({ botId: "b1", userId: "c1", rating: "down", message: "Il manque TikTok", conversationId: null });
  });
  it("vide → 400, trop de retours → 429", async () => {
    loadBot.mockResolvedValue(BOT);
    fbCount.mockResolvedValue(0);
    expect((await feedbackPOST(req({ message: "  " }), ctx)).status).toBe(400);
    fbCount.mockResolvedValue(40);
    expect((await feedbackPOST(req({ message: "encore" }), ctx)).status).toBe(429);
  });
});
