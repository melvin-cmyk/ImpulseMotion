import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TikTok Ads in the alerting: the automatic alerts (who is watched, the
 * scanner), the alerts created with the AI (validation, series), the personal
 * rules (/me/alerts). TikTok itself is replaced: lib/tiktok-data.ts is mocked.
 */
const h = vi.hoisted(() => ({ daily: vi.fn(), totals: vi.fn(), active: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/cockpit/fetch", () => ({ listMetaAccounts: vi.fn(), listGoogleAccounts: vi.fn() }));
vi.mock("@/lib/cockpit/build", () => ({ syncAccounts: vi.fn() }));
vi.mock("@/lib/tiktok-data", () => ({ fetchTikTokDaily: h.daily, fetchTikTokTotals: h.totals, tiktokHasActiveCampaign: h.active }));
// The real cache needs a database: every read goes to the fetcher here.
vi.mock("@/lib/kpi-cache", () => ({ cached: (_key: string, fetcher: () => Promise<unknown>) => fetcher(), ttlForRange: () => 60_000 }));

import { buildClients, clientInScope, parseAccounts, parseAlertAccounts, tiktokCandidates, type BuildInput } from "@/lib/auto-alerts/clients";
import { scansTikTok, tagAccount } from "@/lib/auto-alerts/run";
import { scanTikTokAccount } from "@/lib/auto-alerts/tiktok";
import { detectFromDays, type DayPoint } from "@/lib/auto-alerts/detect";
import { fetchTikTokAccountMetrics, metricsFromTikTok } from "@/lib/alert-tiktok";
import { parseAlertPlatform, validateRuleInput } from "@/lib/alert-entities";
import { parseProposal } from "@/lib/alert-ai";
import { evaluate } from "@/lib/client-alerts/evaluate";
import type { AccountSeries, AlertAccountRef, AlertDefinition, ClientSeries } from "@/lib/client-alerts/types";
import type { TikTokDailyRow } from "@/lib/tiktok-data";

const TT = "7412345678901234567";
const meta = (accountId: string, name: string) => ({ platform: "meta" as const, accountId, name, currency: "EUR", active: true });
const google = (accountId: string, name: string) => ({ platform: "google" as const, accountId, name, currency: "EUR", active: true });
const input = (over: Partial<BuildInput>): BuildInput => ({ available: [], cockpit: [], cockpitNames: new Map(), dashboards: [], ...over });
const board = (id: string, name: string, metaAccountId: string | null, tiktokAdvertiserIds: string[] = []) =>
  ({ id, name, metaAccountId, googleCustomerId: null, tiktokAdvertiserIds, createdAt: new Date("2026-01-01T00:00:00Z") });

describe("alertes automatiques — qui est surveillé sur TikTok", () => {
  it("un compte TikTok seul devient un client, sous la clé tiktok:<id>", () => {
    const clients = buildClients(input({ tiktok: [{ accountId: TT, name: "Jow TikTok", currency: "EUR" }] }));
    expect(clients).toEqual([{ key: `tiktok:${TT}`, name: "Jow TikTok", dashboardIds: [], accounts: [{ platform: "tiktok", accountId: TT, name: "Jow TikTok", currency: "EUR" }] }]);
  });

  it("met côte à côte le compte Meta et le compte TikTok d'un dashboard, Meta d'abord", () => {
    const clients = buildClients(input({
      available: [meta("20", "Sumix Meta")],
      tiktok: [{ accountId: TT, name: "Sumix TT", currency: "EUR" }],
      dashboards: [board("a", "Sumix", "act_20", [TT])],
    }));
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ key: "meta:20", dashboardIds: ["a"] });
    expect(clients[0].accounts.map((a) => a.platform)).toEqual(["meta", "tiktok"]);
  });

  it("rattache un compte TikTok au client de la feuille des budgets", () => {
    const clients = buildClients(input({
      available: [google("12", "LPEV - Search")],
      tiktok: [{ accountId: TT, name: "Compte TT", currency: "EUR" }],
      cockpit: [{ platform: "google", accountId: "12", clientKey: "lpev" }, { platform: "tiktok", accountId: TT, clientKey: "lpev" }],
      cockpitNames: new Map([["lpev", "LPEV"]]),
    }));
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ key: "c:lpev", name: "LPEV" });
    expect(clients[0].accounts.map((a) => `${a.platform}:${a.accountId}`)).toEqual(["google:12", `tiktok:${TT}`]);
  });

  it("un client sans nom prend « Compte TikTok Ads <id> », jamais « Meta »", () => {
    const clients = buildClients(input({ tiktok: [{ accountId: TT, name: TT, currency: null }] }));
    expect(clients[0].name).toBe(`Compte TikTok Ads ${TT}`);
  });

  it("les comptes candidats : dashboards (nom, devise) puis feuille, une seule fois chacun", () => {
    const out = tiktokCandidates(
      [{ externalId: ` ${TT} `, label: "Jow", config: JSON.stringify({ currency: "USD", timezone: "America/New_York" }) }, { externalId: "742", label: null, config: "pas du json" }],
      [{ platform: "tiktok", accountId: TT, name: "Autre nom", currency: "EUR" }, { platform: "tiktok", accountId: "743", name: "Feuille", currency: null }, { platform: "meta", accountId: "1", name: "Meta" }],
    );
    expect(out).toEqual([
      { accountId: TT, name: "Jow", currency: "USD" },
      { accountId: "742", name: "742", currency: null },
      { accountId: "743", name: "Feuille", currency: null },
    ]);
  });

  it("lit TikTok dans la liste stockée ; les surfaces Meta / Google seulement ne le voient pas ; rien d'inconnu n'est lu comme Meta", () => {
    const json = JSON.stringify([{ platform: "meta", accountId: "1", name: "M" }, { platform: "tiktok", accountId: TT, name: "T", currency: "EUR" }, { platform: "snap", accountId: "9", name: "S" }]);
    expect(parseAlertAccounts(json).map((a) => a.platform)).toEqual(["meta", "tiktok"]);
    expect(parseAccounts(json).map((a) => a.platform)).toEqual(["meta"]);
  });

  it("un client TikTok est visible de qui a le compte TikTok dans son périmètre", () => {
    const accounts = [{ platform: "tiktok" as const, accountId: TT, name: "T", currency: "EUR" }];
    expect(clientInScope({ all: false, meta: new Set([TT]), google: new Set(), tiktok: new Set() }, accounts)).toBe(false);
    expect(clientInScope({ all: false, meta: new Set(), google: new Set(), tiktok: new Set([TT]) }, accounts)).toBe(true);
  });
});

// ── Scanner ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-30T10:00:00Z"); // 12 h in Paris
/** Ten full days 2026-09-20 → 09-29 at `spend`, with `conv` conversions, then `last` yesterday. */
function rows(spend: number, conv: number, over: Partial<Record<string, Partial<TikTokDailyRow>>> = {}): TikTokDailyRow[] {
  const out: TikTokDailyRow[] = [];
  for (let d = 20; d <= 30; d++) {
    const date = `2026-09-${d}`;
    const row = { date, spend, impressions: 10_000, clicks: 100, conversions: conv, purchases: conv, purchaseValue: 0, videoViews: 0, ...over[date] };
    // TikTok leaves out the days without anything.
    if (row.spend > 0 || row.conversions > 0) out.push(row);
  }
  return out;
}

describe("alertes automatiques — ouverture de TikTok dans Slack", () => {
  it("TikTok n'est lu en vrai qu'avec AUTO_ALERTS_TIKTOK=1 ; un passage à blanc le mesure toujours", () => {
    expect(scansTikTok({}, {})).toBe(false);
    expect(scansTikTok({ dryRun: false }, { AUTO_ALERTS_TIKTOK: "0" })).toBe(false);
    expect(scansTikTok({ dryRun: true }, {})).toBe(true);
    expect(scansTikTok({}, { AUTO_ALERTS_TIKTOK: "1" })).toBe(true);
  });
});

describe("alertes automatiques — scanner TikTok", () => {
  beforeEach(() => { h.daily.mockReset(); h.active.mockReset(); h.active.mockResolvedValue(true); });

  it("une lecture par compte, sur 11 jours en heure de Paris", async () => {
    h.daily.mockResolvedValue(rows(100, 5));
    const scan = await scanTikTokAccount(TT, "EUR", NOW, { EUR: 1 });
    expect(h.daily).toHaveBeenCalledTimes(1);
    expect(h.daily).toHaveBeenCalledWith(TT, "2026-09-20", "2026-09-30");
    expect(scan.findings).toEqual([]);
    expect([...scan.evaluated]).toEqual(["tiktok:days"]);
    expect(scan.series).toHaveLength(10);
  });

  it("dépense à l'arrêt : le jour absent de TikTok compte pour zéro", async () => {
    h.daily.mockResolvedValue(rows(100, 5, { "2026-09-29": { spend: 0, conversions: 0 } }));
    const scan = await scanTikTokAccount(TT, "EUR", NOW, { EUR: 1 });
    expect(scan.findings.map((f) => [f.key, f.kind, f.platform, f.scope, f.title])).toEqual([
      ["tiktok:spend_stopped", "spend_stopped", "tiktok", "tiktok:days", "TikTok Ads · Dépense à l'arrêt"],
    ]);
    expect(h.active).toHaveBeenCalledWith(TT);
  });

  it("dépense à l'arrêt sans aucune campagne allumée : pause volontaire, rien n'est signalé", async () => {
    h.daily.mockResolvedValue(rows(100, 5, { "2026-09-29": { spend: 0, conversions: 0 } }));
    h.active.mockResolvedValue(false);
    expect((await scanTikTokAccount(TT, "EUR", NOW, { EUR: 1 })).findings).toEqual([]);
  });

  it("liste des campagnes illisible : rien ne part, l'erreur est notée (Slack reste calme)", async () => {
    h.daily.mockResolvedValue(rows(100, 5, { "2026-09-29": { spend: 0, conversions: 0 } }));
    h.active.mockRejectedValue(new Error("TikTok 40100"));
    const scan = await scanTikTokAccount(TT, "EUR", NOW, { EUR: 1 });
    expect(scan.errors.join(" ")).toMatch(/40100/);
    expect(scan.findings).toEqual([]);
  });

  it("la liste des campagnes n'est lue que pour confirmer un arrêt", async () => {
    h.daily.mockResolvedValue(rows(100, 5));
    await scanTikTokAccount(TT, "EUR", NOW, { EUR: 1 });
    expect(h.active).not.toHaveBeenCalled();
  });

  it("plus aucune conversion sur un compte qui convertit d'habitude", async () => {
    h.daily.mockResolvedValue(rows(100, 5, { "2026-09-28": { conversions: 0 }, "2026-09-29": { conversions: 0 } }));
    const scan = await scanTikTokAccount(TT, "EUR", NOW, { EUR: 1 });
    expect(scan.findings.map((f) => f.kind)).toEqual(["conversions_zero"]);
  });

  it("pic et chute de dépense", async () => {
    h.daily.mockResolvedValueOnce(rows(100, 5, { "2026-09-29": { spend: 400 } }));
    expect((await scanTikTokAccount(TT, "EUR", NOW, { EUR: 1 })).findings.map((f) => f.kind)).toEqual(["spend_spike"]);
    h.daily.mockResolvedValueOnce(rows(100, 5, { "2026-09-29": { spend: 30 } }));
    expect((await scanTikTokAccount(TT, "EUR", NOW, { EUR: 1 })).findings.map((f) => f.kind)).toEqual(["spend_drop"]);
  });

  it("aucune dérive de performance sur TikTok : les ruptures nettes seulement", async () => {
    // CPA multiplied by five over the last three days: Google would raise a drift, TikTok does not.
    const series = rows(100, 10, { "2026-09-27": { conversions: 2 }, "2026-09-28": { conversions: 2 }, "2026-09-29": { conversions: 2 } });
    const days: DayPoint[] = series.slice(0, 10).map((r) => ({ date: r.date, spend: r.spend, conversions: r.conversions, revenue: null }));
    expect(detectFromDays({ platform: "google", full: days, today: null, currency: "EUR" }).map((f) => f.kind)).toEqual(["perf_drift"]);
    h.daily.mockResolvedValue(series);
    expect((await scanTikTokAccount(TT, "EUR", NOW, { EUR: 1 })).findings).toEqual([]);
  });

  it("seuils en euros : un petit compte dans une autre devise ne déclenche rien", async () => {
    h.daily.mockResolvedValue(rows(1000, 5, { "2026-09-29": { spend: 0, conversions: 0 } }));
    // 1 000 JPY a day ≈ 6 €: under the 30 € a day an account needs.
    expect((await scanTikTokAccount(TT, "JPY", NOW, { EUR: 1, JPY: 0.006 })).findings).toEqual([]);
  });

  it("une lecture qui échoue : rien d'évalué, donc rien d'ouvert ni de fermé", async () => {
    h.daily.mockRejectedValue(new Error("TikTok 40001 : limite"));
    const scan = await scanTikTokAccount(TT, "EUR", NOW, { EUR: 1 });
    expect(scan.evaluated.size).toBe(0);
    expect(scan.errors).toEqual(["tiktok jours : TikTok 40001 : limite"]);
  });

  it("un compte TikTok sans dépense depuis dix jours est en sommeil", async () => {
    h.daily.mockResolvedValue([]);
    const scan = await scanTikTokAccount(TT, "EUR", NOW, { EUR: 1 });
    const out = tagAccount({ platform: "tiktok", accountId: TT, name: "T", currency: "EUR" }, scan, { siblings: 1, openKeys: new Set() });
    expect(out.dormant).toBe(true);
    expect(out.evaluated).toEqual([`tiktok:days@${TT}`]);
  });
});

// ── Alertes créées avec l'IA ─────────────────────────────────────────────────

describe("alertes client — TikTok jugé avec les autres plateformes", () => {
  const META: AlertAccountRef = { platform: "meta", accountId: "1", name: "M", currency: "EUR" };
  const TIKTOK: AlertAccountRef = { platform: "tiktok", accountId: TT, name: "T", currency: "EUR" };
  const days = (spend: number) => Array.from({ length: 20 }, (_, i) => ({
    date: `2026-09-${String(10 + i).padStart(2, "0")}`, spend, conversions: 2, revenue: null, clicks: 10, impressions: 1000,
  }));
  const read = (account: AlertAccountRef, spend: number): AccountSeries => ({ account, currency: "EUR", eurRate: 1, days: days(spend), today: null });
  const series: ClientSeries = { readAt: "2026-09-30T06:00:00Z", until: "2026-09-29", accounts: [read(META, 100), read(TIKTOK, 50)] };
  const def = (over: Partial<AlertDefinition>): AlertDefinition => ({
    version: 1, label: "Dépense", accounts: [META, TIKTOK], metric: "spend", aggregation: "combined", condition: "above", threshold: 120,
    windowDays: 1, compare: "previous_window", guards: {}, checks: "2x", weekdaysOnly: false, cooldownHours: 72, remind: false, explanation: "", ...over,
  });

  it("additionne TikTok aux autres et le détaille", () => {
    const e = evaluate(def({}), series);
    expect(e.status).toBe("triggered");
    expect(e.value).toBe(150);
    expect(e.parts.map((p) => [p.scope, p.spend])).toEqual([["combined", 150], ["meta", 100], ["tiktok", 50]]);
  });

  it("juge TikTok seul quand chaque plateforme l'est", () => {
    const e = evaluate(def({ aggregation: "each", threshold: 80 }), series);
    expect(e.parts.map((p) => [p.scope, p.triggered])).toEqual([["meta", true], ["tiktok", false]]);
  });
});

// ── Règles personnelles (/me/alerts) ─────────────────────────────────────────

describe("règles personnelles — TikTok Ads", () => {
  beforeEach(() => { h.totals.mockReset(); });

  it("une plateforme inconnue reste Meta, TikTok reste TikTok", () => {
    expect(parseAlertPlatform("tiktok")).toBe("tiktok");
    expect(parseAlertPlatform("google")).toBe("google");
    expect(parseAlertPlatform(undefined)).toBe("meta");
  });

  it("compte entier seulement, sans fréquence ni alerte IA", () => {
    const rule = { metric: "cpa", condition: "above", threshold: 30, window: "7d" };
    expect(validateRuleInput(rule, { platform: "tiktok" }).ok).toBe(true);
    expect(validateRuleInput({ ...rule, level: "campaign" }, { platform: "tiktok" })).toEqual({ ok: false, error: "niveau « Campagne » indisponible sur TikTok Ads" });
    expect(validateRuleInput({ ...rule, metric: "frequency" }, { platform: "tiktok" })).toEqual({ ok: false, error: "métrique « frequency » indisponible sur TikTok Ads" });
    const ai = validateRuleInput({ mode: "ai", prompt: "préviens-moi si ça dérape" }, { platform: "tiktok" });
    expect(ai.ok).toBe(false);
    // A partial update of a TikTok rule is judged as TikTok too.
    expect(validateRuleInput({ mode: "ai" }, { partial: true, platform: "tiktok" }).ok).toBe(false);
  });

  it("les totaux TikTok donnent dépense, CPA, CTR en %, et un ROAS seulement avec une valeur d'achat", () => {
    const base = { spend: 1000, impressions: 50_000, clicks: 600, conversions: 40, purchases: 30, purchaseValue: 0, videoViews: 0 };
    expect(metricsFromTikTok(base)).toEqual({ spend: 1000, roas: 0, cpa: 25, ctr: 1.2, frequency: 0, roasAvailable: false, roasEstimated: false, conversions: 40 });
    expect(metricsFromTikTok({ ...base, purchaseValue: 3500 })).toMatchObject({ roas: 3.5, roasAvailable: true });
    expect(metricsFromTikTok(null).roasAvailable).toBe(false);
  });

  it("deux lectures : la fenêtre et la précédente", async () => {
    h.totals.mockResolvedValue({ spend: 700, impressions: 7000, clicks: 70, conversions: 7, purchases: 0, purchaseValue: 0, videoViews: 0 });
    const m = await fetchTikTokAccountMetrics(TT, "7d");
    expect(h.totals).toHaveBeenCalledTimes(2);
    expect(h.totals.mock.calls.map((c) => c[0])).toEqual([TT, TT]);
    expect(m.current.cpa).toBe(100);
    expect(m.range.until > m.compare.until).toBe(true);
  });

  it("l'IA de rédaction propose TikTok en règle classique, refuse une alerte IA sur TikTok", () => {
    const rule = parseProposal('```json\n{"mode":"rule","platform":"tiktok","label":"CPA","level":"ad","metric":"cpa","condition":"above","threshold":30,"window":"7d"}\n```');
    expect(rule).toMatchObject({ mode: "rule", platform: "tiktok", level: "account", metric: "cpa" });
    expect(() => parseProposal('```json\n{"mode":"ai","platform":"tiktok","prompt":"x","level":"account","window":"7d"}\n```')).toThrow(/TikTok/);
    expect(() => parseProposal('{"mode":"rule","metric":"frequency","condition":"above","threshold":3}', "tiktok")).toThrow(/métrique inconnue/);
  });
});
