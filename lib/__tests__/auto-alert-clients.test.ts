import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/cockpit/fetch", () => ({ listMetaAccounts: vi.fn(), listGoogleAccounts: vi.fn() }));
vi.mock("@/lib/cockpit/build", () => ({ syncAccounts: vi.fn() }));

import { buildClients, looksLikeId, reconcile, type BuildInput } from "@/lib/auto-alerts/clients";
import { MAX_MESSAGES, floodedKinds, tagAccount } from "@/lib/auto-alerts/run";
import type { Finding } from "@/lib/auto-alerts/detect";

const meta = (accountId: string, name: string, active = true) => ({ platform: "meta" as const, accountId, name, currency: "EUR", active });
const google = (accountId: string, name: string, active = true) => ({ platform: "google" as const, accountId, name, currency: "EUR", active });
const board = (id: string, name: string, metaAccountId: string | null, googleCustomerId: string | null = null) =>
  ({ id, name, metaAccountId, googleCustomerId, createdAt: new Date(`2026-01-0${id.length}T00:00:00Z`) });
const input = (over: Partial<BuildInput>): BuildInput => ({ available: [], cockpit: [], cockpitNames: new Map(), dashboards: [], ...over });

describe("buildClients", () => {
  it("watches every readable account, with or without a dashboard", () => {
    const clients = buildClients(input({ available: [meta("1", "Vorwerk FR"), google("2", "Naturalia"), google("3", "Ancien compte", false)] }));
    expect(clients.map((c) => [c.key, c.name])).toEqual([["google:2", "Naturalia"], ["meta:1", "Vorwerk FR"]]);
  });

  it("gathers the accounts of one client of the sheet under its name", () => {
    const clients = buildClients(input({
      available: [meta("10", "Laboratoire LPEV 2"), meta("11", "LPEV Traffic"), google("12", "LPEV - Search")],
      cockpit: [{ platform: "meta", accountId: "10", clientKey: "lpev" }, { platform: "meta", accountId: "11", clientKey: "lpev" }, { platform: "google", accountId: "12", clientKey: "lpev" }],
      cockpitNames: new Map([["lpev", "LPEV"]]),
    }));
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ key: "c:lpev", name: "LPEV" });
    expect(clients[0].accounts.map((a) => a.accountId)).toEqual(["10", "11", "12"]);
  });

  it("puts side by side the Meta and Google accounts of a dashboard", () => {
    const clients = buildClients(input({
      available: [meta("20", "Sumix Meta"), google("21", "Sumix Google")],
      dashboards: [board("a", "Sumix", "act_20", "000-000-0021")],
    }));
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ key: "meta:20", name: "Sumix Meta", dashboardIds: ["a"] });
  });

  it("gathers the accounts that bear the same name", () => {
    const clients = buildClients(input({
      available: [meta("40", "Quartier IODE"), google("41", "QUARTIER IODE"), meta("42", "EcoleMultimedia"), google("43", "ECOLE MULTIMEDIA"), google("44", "Clair Lagon FR"), meta("45", "Clair Lagon"), meta("46", "Labelys Store"), google("47", "Labelys")],
    }));
    expect(clients.map((c) => c.accounts.map((a) => a.accountId).join("+"))).toEqual(["45+44", "42+43", "47", "46", "40+41"]);
  });

  it("names a client after the account that is scanned, not after the dashboard", () => {
    const clients = buildClients(input({ available: [meta("50", "Mademoiselle Provence USA")], dashboards: [board("a", "La Perle de Marie-Jo", "50")] }));
    expect(clients[0].name).toBe("Mademoiselle Provence USA");
  });

  it("names a client after its account when the dashboard is named after an id", () => {
    const clients = buildClients(input({
      available: [meta("215903989640516", "Maison Dupont")],
      dashboards: [board("a", "215903989640516", "act_215903989640516")],
    }));
    expect(clients.map((c) => c.name)).toEqual(["Maison Dupont"]);
    expect(buildClients(input({ available: [meta("1543285195886235", "")] }))[0].name).toBe("Compte Meta 1543285195886235");
    expect(looksLikeId("Compte 1543285195886235")).toBe(true);
    expect(looksLikeId("Studio 54")).toBe(false);
  });

  it("does not watch an account the agency can no longer read", () => {
    // The dashboard still points to account 30, the platform no longer lists it.
    expect(buildClients(input({ dashboards: [board("a", "ICN Business School", "30")] }))).toEqual([]);
    const clients = buildClients(input({ available: [google("31", "ICN - ARTEM")], dashboards: [board("a", "ICN Business School", "30", "31")] }));
    expect(clients).toHaveLength(1);
    expect(clients[0].accounts.map((a) => a.accountId)).toEqual(["31"]);
  });
});

describe("reconcile", () => {
  const draft = (key: string, ids: string[]) => ({ key, name: key, accounts: ids.map((id) => ({ platform: "meta" as const, accountId: id, name: id, currency: null })), dashboardIds: [] });
  const stored = (id: string, key: string, ids: string[], hasChannel = false) => ({ id, key, accounts: draft(key, ids).accounts, hasChannel });

  it("keeps the channel of a client whose key changes", () => {
    // Accounts 1 and 2 were two clients; the sheet now says they are one.
    const r = reconcile([draft("c:lpev", ["1", "2"])], [stored("x", "meta:1", ["1"]), stored("y", "meta:2", ["2"], true)]);
    expect(r.pairs[0].existingId).toBe("y");
    expect(r.orphans).toEqual(["x"]);
  });

  it("creates what is new and never steals a client that still exists", () => {
    const r = reconcile([draft("meta:1", ["1"]), draft("meta:2", ["2"])], [stored("x", "meta:1", ["1", "2"])]);
    expect(r.pairs.map((p) => p.existingId)).toEqual(["x", null]);
    expect(r.orphans).toEqual([]);
  });
});

describe("tagAccount", () => {
  const account = { platform: "meta" as const, accountId: "10", name: "LPEV Traffic", currency: "EUR" };
  const finding: Finding = { key: "meta:account_blocked", scope: "meta:account", platform: "meta", kind: "account_blocked", severity: "critical", title: "Meta Ads · Compte bloqué", detail: "d" };
  const day = (spend: number) => ({ date: "2026-09-27", spend, conversions: 0, revenue: null });
  const evaluated = new Set(["meta:account", "meta:days"] as const);

  it("puts the account in the key, and in the title when the client has several", () => {
    const out = tagAccount(account, { findings: [finding], evaluated, series: [day(120)] }, { siblings: 2, openKeys: new Set() });
    expect(out.findings[0]).toMatchObject({ key: "meta:account_blocked@10", scope: "meta:account@10", title: "Meta Ads · Compte bloqué (LPEV Traffic)" });
    expect(out.evaluated).toEqual(["meta:account@10", "meta:days@10"]);
    expect(tagAccount(account, { findings: [finding], evaluated, series: [day(120)] }, { siblings: 1, openKeys: new Set() }).findings[0].title).toBe("Meta Ads · Compte bloqué");
  });

  it("raises nothing new on an account that spent nothing, but keeps following what is open", () => {
    const quiet = { findings: [finding], evaluated, series: [day(0), day(0)] };
    expect(tagAccount(account, quiet, { siblings: 1, openKeys: new Set() })).toMatchObject({ findings: [], dormant: true });
    expect(tagAccount(account, quiet, { siblings: 1, openKeys: new Set(["meta:account_blocked@10"]) }).findings).toHaveLength(1);
  });

  it("does not call dormant an account whose days could not be read", () => {
    const out = tagAccount(account, { findings: [finding], evaluated: new Set(["meta:account"] as const), series: [] }, { siblings: 1, openKeys: new Set() });
    expect(out).toMatchObject({ dormant: false });
    expect(out.findings).toHaveLength(1);
  });
});

describe("what reaches Slack", () => {
  const stop = (n: number) => Array.from({ length: n }, (_, i) => ({ clientId: `c${i}`, kinds: ["spend_stopped"] }));

  it("holds a break seen on many clients at once", () => {
    expect(floodedKinds(stop(3), 40)).toEqual([]);
    // 12 of 40 clients stopped the same morning: the platform, not the clients.
    expect(floodedKinds(stop(12), 40)).toEqual(["spend_stopped"]);
    expect(floodedKinds(stop(11), 40)).toEqual([]);
    // Few clients scanned: four is the floor.
    expect(floodedKinds(stop(4), 8)).toEqual(["spend_stopped"]);
  });

  it("only holds the breaks, and only the kind that floods", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ clientId: `c${i}`, kinds: ["account_blocked", "perf_drift"] }));
    expect(floodedKinds(many, 20)).toEqual([]);
    expect(floodedKinds([...stop(6), { clientId: "x", kinds: ["spend_spike"] }], 10)).toEqual(["spend_stopped"]);
  });

  it("caps a run", () => {
    expect(MAX_MESSAGES).toBeLessThanOrEqual(10);
  });
});
