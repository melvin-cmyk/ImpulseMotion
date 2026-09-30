import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/cockpit/fetch", () => ({ listMetaAccounts: vi.fn(), listGoogleAccounts: vi.fn() }));
vi.mock("@/lib/cockpit/build", () => ({ syncAccounts: vi.fn() }));

import { buildBotClients, countBotClients, planBotDashboard, type ClientInput, type DashboardInput } from "@/lib/bot-clients";

const client = (id: string, name: string, accounts: Array<[("meta" | "google"), string, string?]>, dormant = false): ClientInput => ({
  id, name, dormant, accounts: accounts.map(([platform, accountId, label]) => ({ platform, accountId, name: label ?? `${name} ${platform}` })),
});
const board = (id: string, name: string, meta: string | null, google: string | null, over: Partial<DashboardInput> = {}): DashboardInput => ({
  id, name, metaAccountId: meta, googleCustomerId: google, ownerEmail: "admin@agence.fr", createdAt: "2026-01-01T00:00:00.000Z", bot: null, ...over,
});
const bot = (id: string, over: Partial<NonNullable<DashboardInput["bot"]>> = {}): NonNullable<DashboardInput["bot"]> => ({
  id, enabled: true, name: "Assistant", clientKey: id, sourcesJson: JSON.stringify({ meta: true }), accessCount: 0, lastIngestAt: null, lastIngestRows: null, ...over,
});

describe("every client of the agency, with or without a dashboard", () => {
  it("lists a client that has no dashboard, with its accounts", () => {
    const list = buildBotClients({ clients: [client("c1", "Dufour", [["google", "123-456-7890", "Dufour Yachts"]])], dashboards: [] });
    expect(list.clients).toEqual([{
      id: "c1", name: "Dufour", dormant: false, dashboards: [],
      accounts: [{ platform: "google", accountId: "1234567890", name: "Dufour Yachts", conflicts: [] }],
    }]);
    expect(list.orphans).toEqual([]);
  });

  it("puts the two dashboards of a client on its row, oldest first, each with its bot", () => {
    const list = buildBotClients({
      clients: [client("c1", "LPEV", [["meta", "111111"], ["google", "2222222222"]])],
      dashboards: [
        board("d2", "LPEV (copie)", "act_111111", null, { createdAt: "2026-03-01T00:00:00.000Z" }),
        board("d1", "LPEV", "111111", "222-222-2222", {
          bot: bot("b1", { accessCount: 3, lastIngestAt: new Date("2026-09-01T06:00:00.000Z"), lastIngestRows: 42, sourcesJson: JSON.stringify({ meta: true, data: true, ga4PropertyId: "properties/987" }) }),
        }),
      ],
    });
    expect(list.clients).toHaveLength(1);
    const row = list.clients[0];
    expect(row.dashboards.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(row.dashboards[0].bot).toEqual({
      id: "b1", enabled: true, name: "Assistant", clientKey: "b1", accessCount: 3,
      sources: { meta: true, data: true, ga4PropertyId: "987" }, lastIngestAt: "2026-09-01T06:00:00.000Z", lastIngestRows: 42,
    });
    expect(row.dashboards[1]).toMatchObject({ metaAccountId: "111111", googleCustomerId: null, bot: null, otherClients: [] });
    expect(countBotClients(list)).toMatchObject({ clients: 1, withDashboard: 1, withBot: 1, withoutBot: 0 });
  });

  it("gives the TikTok source of a bot as it was stored, and nothing when it was not ticked", () => {
    const list = buildBotClients({
      clients: [client("c1", "LPEV", [["meta", "111111"]]), client("c2", "Dufour", [["meta", "222222"]])],
      dashboards: [
        board("d1", "LPEV", "111111", null, { bot: bot("b1", { sourcesJson: JSON.stringify({ meta: true, tiktok: true }) }) }),
        board("d2", "Dufour", "222222", null, { bot: bot("b2", { sourcesJson: JSON.stringify({ meta: true, tiktok: "oui" }) }) }),
      ],
    });
    const sources = Object.fromEntries(list.clients.map((c) => [c.name, c.dashboards[0].bot?.sources]));
    expect(sources).toEqual({ LPEV: { meta: true, tiktok: true }, Dufour: { meta: true } });
  });

  it("keeps every account of a client that has several on a platform", () => {
    const list = buildBotClients({
      clients: [client("c1", "Cotton Bird", [["meta", "111111", "Cotton Bird España"], ["meta", "222222", "Cotton Bird Nederland"], ["google", "3333333333"]])],
      dashboards: [board("d1", "Cotton Bird NL", "222222", null)],
    });
    expect(list.clients[0].accounts.map((a) => [a.platform, a.accountId, a.name])).toEqual([
      ["meta", "111111", "Cotton Bird España"], ["meta", "222222", "Cotton Bird Nederland"], ["google", "3333333333", "Cotton Bird google"],
    ]);
    expect(list.clients[0].dashboards.map((d) => d.id)).toEqual(["d1"]);
  });

  it("lists apart a dashboard whose accounts belong to no client — nothing disappears", () => {
    const list = buildBotClients({
      clients: [client("c1", "Dufour", [["meta", "111111"]])],
      dashboards: [board("d9", "Ancien client", "999999", null, { bot: bot("b9", { enabled: false }) }), board("d8", "Sans compte", null, null)],
    });
    expect(list.clients[0].dashboards).toEqual([]);
    expect(list.orphans.map((d) => [d.id, d.bot?.enabled ?? null])).toEqual([["d9", false], ["d8", null]]);
    expect(countBotClients(list).orphans).toBe(2);
  });

  it("says which clients are dormant", () => {
    const list = buildBotClients({ clients: [client("c1", "Actif", [["meta", "111111"]]), client("c2", "Endormi", [["meta", "222222"]], true)], dashboards: [] });
    expect(list.clients.map((c) => [c.name, c.dormant])).toEqual([["Actif", false], ["Endormi", true]]);
    expect(countBotClients(list)).toMatchObject({ active: 1, dormant: 1, withoutDashboard: 2 });
  });

  it("flags an account two clients list, and the dashboard and bot that carry it", () => {
    const list = buildBotClients({
      clients: [client("c1", "Maison A", [["meta", "111111"]]), client("c2", "Maison B", [["meta", "act_111111"], ["google", "2222222222"]])],
      dashboards: [board("d1", "Maison A", "111111", null, { bot: bot("b1") })],
    });
    const [a, b] = list.clients;
    expect(a.accounts[0].conflicts).toEqual([{ client: { id: "c2", name: "Maison B" }, dashboardId: "d1", dashboardName: "Maison A", bot: true }]);
    expect(b.accounts[0].conflicts).toEqual([{ client: { id: "c1", name: "Maison A" }, dashboardId: "d1", dashboardName: "Maison A", bot: true }]);
    expect(b.accounts[1].conflicts).toEqual([]);
    expect(a.dashboards[0].otherClients).toEqual([{ id: "c2", name: "Maison B" }]);
    expect(b.dashboards[0].otherClients).toEqual([{ id: "c1", name: "Maison A" }]);
  });

  it("flags a shared account even when no dashboard carries it yet", () => {
    const list = buildBotClients({ clients: [client("c1", "Maison A", [["meta", "111111"]]), client("c2", "Maison B", [["meta", "111111"]])], dashboards: [] });
    expect(list.clients[0].accounts[0].conflicts).toEqual([{ client: { id: "c2", name: "Maison B" }, dashboardId: null, dashboardName: null, bot: false }]);
  });

  it("flags a dashboard that reads the accounts of two clients", () => {
    const list = buildBotClients({
      clients: [client("c1", "Maison A", [["meta", "111111"]]), client("c2", "Maison B", [["google", "2222222222"]])],
      dashboards: [board("d1", "Mélange", "111111", "2222222222")],
    });
    expect(list.clients.map((c) => c.dashboards[0].otherClients.map((o) => o.name))).toEqual([["Maison B"], ["Maison A"]]);
    expect(list.clients[0].accounts[0].conflicts[0]).toMatchObject({ client: { name: "Maison B" }, dashboardId: "d1" });
  });
});

describe("opening a bot to a client", () => {
  const rows = (clients: ClientInput[], dashboards: DashboardInput[] = []) => buildBotClients({ clients, dashboards }).clients;
  const multi = client("c1", "Cotton Bird", [["meta", "111111"], ["meta", "222222"], ["google", "3333333333"]]);

  it("creates the dashboard on the accounts the admin picked, and only those", () => {
    expect(planBotDashboard(rows([multi])[0], { metaAccountId: "act_222222" })).toEqual({ kind: "create", metaAccountId: "222222", googleCustomerId: null });
    expect(planBotDashboard(rows([multi])[0], { metaAccountId: "111111", googleCustomerId: "333-333-3333" })).toEqual({ kind: "create", metaAccountId: "111111", googleCustomerId: "3333333333" });
  });

  it("never guesses the accounts", () => {
    expect(planBotDashboard(rows([multi])[0], {})).toMatchObject({ kind: "refuse", status: 400 });
  });

  it("refuses an account of another client", () => {
    const [a] = rows([client("c1", "Maison A", [["meta", "111111"]]), client("c2", "Maison B", [["meta", "222222"]])]);
    expect(planBotDashboard(a, { metaAccountId: "222222" })).toMatchObject({ kind: "refuse", status: 403 });
    expect(planBotDashboard(a, { metaAccountId: "111111", googleCustomerId: "222222" })).toMatchObject({ kind: "refuse", status: 403 });
  });

  it("refuses an account two clients list", () => {
    const [a] = rows([client("c1", "Maison A", [["meta", "111111"]]), client("c2", "Maison B", [["meta", "111111"]])]);
    expect(planBotDashboard(a, { metaAccountId: "111111" })).toMatchObject({ kind: "refuse", status: 409 });
  });

  it("uses again the dashboard that already reads these accounts", () => {
    const [row] = rows([multi], [board("d1", "CB", "111111", "3333333333"), board("d2", "CB NL", "222222", null)]);
    expect(planBotDashboard(row, { metaAccountId: "111111", googleCustomerId: "3333333333" })).toEqual({ kind: "reuse", dashboardId: "d1" });
    expect(planBotDashboard(row, { metaAccountId: "222222" })).toEqual({ kind: "reuse", dashboardId: "d2" });
    expect(planBotDashboard(row, { metaAccountId: "222222", googleCustomerId: "3333333333" })).toEqual({ kind: "reuse", dashboardId: "d2" });
    expect(planBotDashboard(row, {})).toEqual({ kind: "reuse", dashboardId: "d1" });
  });

  it("does not use a dashboard that reads another account of the platform", () => {
    const [row] = rows([multi], [board("d1", "CB", "111111", "3333333333")]);
    expect(planBotDashboard(row, { metaAccountId: "222222", googleCustomerId: "3333333333" })).toEqual({ kind: "create", metaAccountId: "222222", googleCustomerId: "3333333333" });
  });

  it("does not use a dashboard that also reads another client", () => {
    const [a] = rows(
      [client("c1", "Maison A", [["meta", "111111"]]), client("c2", "Maison B", [["google", "2222222222"]])],
      [board("d1", "Mélange", "111111", "2222222222")],
    );
    expect(planBotDashboard(a, {})).toMatchObject({ kind: "refuse", status: 409 });
    expect(planBotDashboard(a, { metaAccountId: "111111" })).toMatchObject({ kind: "refuse", status: 409 });
  });
});
