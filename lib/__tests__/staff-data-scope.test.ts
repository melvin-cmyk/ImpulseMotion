import { beforeEach, describe, expect, it, vi } from "vitest";

const bots: Array<{ clientKey: string; dashboardId: string; sourcesJson: string; dashboard: { name: string } }> = [];

vi.mock("@/lib/prisma", () => ({
  prisma: { clientBot: { findMany: async () => bots } },
}));

import {
  listStaffDataClients,
  resetStaffDataScopeMemo,
  staffDataClientsLine,
  staffDataScopeForAll,
  staffDataScopeForDashboard,
} from "@/lib/staff-data-scope";
import { buildConsoleSystemPrompt } from "@/lib/ai-tool-guidance";

describe("staff data scope (entrepôt vu par le staff)", () => {
  beforeEach(() => {
    bots.length = 0;
    resetStaffDataScopeMemo();
  });

  it("ne garde que les bots dont une source de données est cochée, activés ou non", async () => {
    bots.push(
      { clientKey: "lpev", dashboardId: "d1", sourcesJson: JSON.stringify({ meta: true, data: true }), dashboard: { name: "LPEV" } },
      { clientKey: "dt", dashboardId: "d2", sourcesJson: JSON.stringify({ meta: true, files: true }), dashboard: { name: "Decathlon Travel" } },
      { clientKey: "icn", dashboardId: "d3", sourcesJson: JSON.stringify({ meta: true }), dashboard: { name: "ICN" } },
    );
    const clients = await listStaffDataClients();
    expect(clients.map((c) => c.clientKey)).toEqual(["lpev", "dt"]);
    expect(clients[0].tools).toEqual(["orders"]);
    expect(clients[1].tools).toEqual(["datasets"]);

    const all = await staffDataScopeForAll();
    expect(all).toEqual({ staff: true, clientKeys: ["lpev", "dt"], tools: ["orders", "datasets"] });

    const one = await staffDataScopeForDashboard("d1");
    expect(one).toEqual({ staff: true, clientKeys: ["lpev"], tools: ["orders"] });
    expect(await staffDataScopeForDashboard("d3")).toBeUndefined();
  });

  it("sans client alimenté : pas de périmètre, pas de ligne de contexte", async () => {
    expect(await staffDataScopeForAll()).toBeUndefined();
    expect(staffDataClientsLine([])).toBe("");
  });

  it("la console nomme les clients et leur clé après la frontière du prompt", async () => {
    bots.push({ clientKey: "lpev", dashboardId: "d1", sourcesJson: JSON.stringify({ data: true }), dashboard: { name: "LPEV" } });
    const line = staffDataClientsLine(await listStaffDataClients());
    expect(line).toContain("LPEV (client = « lpev »)");
    const prompt = buildConsoleSystemPrompt("melvin@impulse-analytics.com", line);
    const [staticPart, dynamicPart] = prompt.split("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
    expect(staticPart).toContain("ENTREPÔT E-COMMERCE (outils mcp__client-data__data_*");
    expect(staticPart).toContain("MAGENTO LPEV EN DIRECT");
    // The static block names no client of its own: the list is per caller, after the boundary.
    expect(staticPart).not.toContain("LPEV (client = ");
    expect(dynamicPart).toContain(line);
    expect(dynamicPart).toContain("SIGNATURE DES NOTES HQ");
  });
});
