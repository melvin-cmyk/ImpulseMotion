import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const rows = new Map<string, { id: string; userId: string; title: string; messagesJson: string; updatedAt: Date }>();
let currentUser = "alice";

vi.mock("@/lib/auth-helpers", () => ({
  requireSession: async () => ({ session: { userId: currentUser, role: "consultant" } }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    consoleConversation: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
        const r = rows.get(where.id);
        return r && r.userId === where.userId ? r : null;
      },
      findMany: async ({ where, skip }: { where: { userId: string }; skip?: number }) =>
        [...rows.values()].filter((r) => r.userId === where.userId).slice(skip ?? 0),
      create: async ({ data }: { data: { id: string; userId: string; title: string; messagesJson: string } }) => {
        const r = { ...data, updatedAt: new Date() };
        rows.set(data.id, r);
        return r;
      },
      update: async ({ where, data }: { where: { id: string }; data: { title: string; messagesJson: string } }) => {
        const r = { ...rows.get(where.id)!, ...data, updatedAt: new Date() };
        rows.set(where.id, r);
        return r;
      },
      deleteMany: async ({ where }: { where: { id: string | { in: string[] }; userId: string } }) => {
        const ids = typeof where.id === "string" ? [where.id] : where.id.in;
        let count = 0;
        for (const id of ids) if (rows.get(id)?.userId === where.userId) { rows.delete(id); count++; }
        return { count };
      },
    },
  },
}));

import { GET, PUT, DELETE } from "@/app/api/relay/conversations/[id]/route";
import { GET as LIST } from "@/app/api/relay/conversations/route";

const ID = "3f2b8c1e-5d4a-4f6b-9c7d-1a2b3c4d5e6f";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const put = (id: string, messages: unknown) =>
  PUT(new NextRequest(`http://x/api/relay/conversations/${id}`, { method: "PUT", body: JSON.stringify({ messages }) }), ctx(id));
const get = (id: string) => GET(new NextRequest(`http://x/api/relay/conversations/${id}`), ctx(id));

describe("console conversations are private to their owner", () => {
  beforeEach(() => { rows.clear(); currentUser = "alice"; });

  it("saves and reads back its own conversation", async () => {
    expect((await put(ID, [{ id: "1", role: "user", content: "Bilan LPEV" }])).status).toBe(200);
    const json = await (await get(ID)).json();
    expect(json.title).toBe("Bilan LPEV");
    expect(json.messages).toHaveLength(1);
  });

  it("hides it from another consultant: no read, no overwrite, no delete, not listed", async () => {
    await put(ID, [{ id: "1", role: "user", content: "Confidentiel" }]);
    currentUser = "bob";
    expect((await get(ID)).status).toBe(404);
    expect((await put(ID, [{ id: "1", role: "user", content: "écrasé" }])).status).toBe(404);
    expect((await DELETE(new NextRequest("http://x", { method: "DELETE" }), ctx(ID))).status).toBe(404);
    expect((await (await LIST()).json()).conversations).toEqual([]);
    currentUser = "alice";
    expect((await (await get(ID)).json()).messages[0].content).toBe("Confidentiel");
  });

  it("refuses ids that are not conversation uuids", async () => {
    expect((await put("../x", [{ id: "1", role: "user", content: "a" }])).status).toBe(400);
  });
});
