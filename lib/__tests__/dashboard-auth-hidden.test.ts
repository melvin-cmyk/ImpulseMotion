import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session } from "next-auth";

const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { dashboard: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));
vi.mock("@/lib/scope", () => ({ getAccountScope: async () => ({ all: true }), dashboardInScope: () => true }));

import { loadDashboardFor } from "@/lib/dashboard-auth";

const client = { userId: "c1", role: "client" } as unknown as Session;
const dash = (hidden: boolean) => ({ id: "d1", userId: "owner", widgets: [], pages: [], members: [{ userId: "c1", dashboardHidden: hidden }] });

beforeEach(() => findUnique.mockReset());

describe("loadDashboardFor — dashboard masqué", () => {
  it("client rattaché, dashboard visible → ouvert", async () => {
    findUnique.mockResolvedValue(dash(false));
    expect((await loadDashboardFor(client, "d1")).status).toBe(200);
  });
  it("client rattaché pour l'assistant seulement → 403", async () => {
    findUnique.mockResolvedValue(dash(true));
    expect((await loadDashboardFor(client, "d1")).status).toBe(403);
  });
});
