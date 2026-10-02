import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import type { RelayChatBody } from "@/lib/relay-chat";
import type { AlertAccountRef, AlertDefinition, Backtest, ClientSeries, SlackIdentity } from "@/lib/client-alerts/types";

// Alerts for several clients at once (a « lot », lib/client-alerts/lot.ts), through the routes.
// Same fakes as client-alerts-api.test.ts, with transactions, OR / NOT, and the lot columns.

// ── Fakes: session, database, relay, and the modules of lots A and B ──────

type Session = { userId: string; role: string; baseRole: string; user: { email: string } };
type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;

let session: Session | null = null;
const deny = (status: number, error: string) => ({ error: NextResponse.json({ error }, { status }) });

const alerts: Row[] = [];
const events: Row[] = [];
const clients: Row[] = [];
const users: Row[] = [];
const grants: Array<{ userId: string; platform: string; accountId: string }> = [];
const writes: Array<{ op: string; id?: string; data?: Record<string, unknown> }> = [];
const relayCalls: Array<RelayChatBody & { turnContext?: string }> = [];
const usageRows: Array<Record<string, unknown>> = [];
const seriesReads: AlertAccountRef[][] = [];
let nextId = 1;
let clock = Date.UTC(2026, 8, 1);
let relayDown = false;
let seriesDown = false;
let clientsDown = false;
/** Account ids the platforms cannot read: the series carries their `error`, as the real read does. */
const unreadable = new Set<string>();
let backtestMessages = 2;
let backtestHashOverride: string | null = null;
let slackConfigured = true;

const matches = (row: Row, where: Where = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Where[]).some((w) => matches(row, w));
    if (k === "NOT") return !matches(row, v as Where);
    return v && typeof v === "object" && "in" in (v as object) ? ((v as { in: unknown[] }).in).includes(row[k]) : row[k] === v;
  });
const eventsOf = (id: string, take?: number) =>
  events.filter((e) => e.alertId === id).sort((a, b) => Number(b.triggeredAt as Date) - Number(a.triggeredAt as Date)).slice(0, take ?? 999);
const withEvents = (row: Row | null, include?: { events?: { take?: number } }) =>
  (row && include?.events ? { ...row, events: eventsOf(row.id, include.events.take) } : row);

const fakeHash = (def: AlertDefinition) => {
  const { label: _l, explanation: _e, ...rest } = def;
  void _l; void _e;
  return `h:${JSON.stringify(rest)}`;
};

vi.mock("@/lib/auth-helpers", () => ({
  requireStaff: async () => {
    if (!session) return deny(401, "unauthorized");
    return session.role === "admin" || session.role === "consultant" ? { session } : deny(403, "forbidden");
  },
}));
vi.mock("@/lib/prisma", () => {
  const prisma: Record<string, unknown> = {
    // One request at a time in these tests: the transaction runs its body on the same fake.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    clientAlert: {
      findMany: async ({ where, take, include }: { where?: Where; take?: number; include?: { events?: { take?: number } } }) =>
        alerts.filter((a) => matches(a, where)).sort((a, b) => Number(b.createdAt as Date) - Number(a.createdAt as Date)).slice(0, take ?? 999).map((a) => withEvents(a, include)),
      findUnique: async ({ where, include }: { where: { id: string }; include?: { events?: { take?: number } } }) =>
        withEvents(alerts.find((a) => a.id === where.id) ?? null, include),
      findFirst: async ({ where }: { where?: Where }) => alerts.find((a) => matches(a, where)) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: `alert_${nextId++}`, createdByEmail: null, alertClientId: null, clientName: "—", label: "", accountsJson: "[]", definitionJson: "{}",
          definitionHash: "", status: "draft", backtestJson: "{}", backtestHash: null, backtestAt: null, chatJson: "{}", armed: true,
          lastCheckedAt: null, lastTriggeredAt: null, lastValue: null, lastNote: null, consecutiveFailures: 0, groupId: null, groupJson: "[]", groupPlatforms: "",
          createdAt: new Date(clock += 60_000), updatedAt: new Date(clock), ...data,
        };
        alerts.push(row);
        writes.push({ op: "create", id: row.id, data });
        return row;
      },
      update: async ({ where, data, include }: { where: { id: string }; data: Record<string, unknown>; include?: { events?: { take?: number } } }) => {
        const row = alerts.find((a) => a.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        writes.push({ op: "update", id: row.id, data });
        return withEvents(row, include);
      },
      updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const hit = alerts.filter((a) => matches(a, where));
        for (const row of hit) { Object.assign(row, data); writes.push({ op: "update", id: row.id, data }); }
        return { count: hit.length };
      },
      deleteMany: async ({ where }: { where: Where }) => {
        const hit = alerts.filter((a) => matches(a, where));
        for (const row of hit) { alerts.splice(alerts.indexOf(row), 1); writes.push({ op: "delete", id: row.id }); }
        return { count: hit.length };
      },
    },
    alertClient: {
      findUnique: async ({ where }: { where: { id: string } }) => clients.find((c) => c.id === where.id) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => clients.filter((c) => where.id.in.includes(c.id)),
    },
    user: { findUnique: async ({ where }: { where: { id: string } }) => users.find((u) => u.id === where.id) ?? null },
    userAdAccount: { findMany: async ({ where }: { where: { userId: string } }) => grants.filter((g) => g.userId === where.userId) },
  };
  return { prisma };
});
// The real parseAccounts and clientInScope; only the loader (database, platforms, sheet) is replaced.
vi.mock("@/lib/cockpit/fetch", () => ({ listMetaAccounts: vi.fn(), listGoogleAccounts: vi.fn() }));
vi.mock("@/lib/cockpit/build", () => ({ syncAccounts: vi.fn() }));
vi.mock("@/lib/auto-alerts/clients", async (original) => {
  const real = await original<typeof import("@/lib/auto-alerts/clients")>();
  return {
    ...real,
    loadAlertClients: async (scope: Parameters<typeof real.clientInScope>[0]) => {
      if (clientsDown) throw new Error("Invalid `prisma.alertClient.findMany()` invocation: Can't reach database server at ep-twilight");
      return clients
        .filter((c) => !c.gone)
        .map((c) => ({ id: c.id, key: `k:${c.id}`, name: c.name, accounts: real.parseAccounts(c.accountsJson as string), dashboardId: null, slackChannel: "#canal-du-client", slackChannelId: "C123", autoAlerts: true, autoAlertConfig: "{}", dormant: !!c.dormant, lastScanAt: null }))
        .filter((c) => real.clientInScope(scope, c.accounts));
    },
  };
});
vi.mock("@/lib/client-alerts/series", () => ({
  readClientSeries: async (accounts: AlertAccountRef[]): Promise<ClientSeries> => {
    seriesReads.push(accounts);
    if (seriesDown) throw new Error("Meta rate limit");
    return {
      readAt: "2026-09-30T06:00:00.000Z", until: "2026-09-29",
      accounts: accounts.map((account) => (unreadable.has(account.accountId)
        ? { account, currency: "EUR", eurRate: 1, today: null, days: [], error: "lecture Google Ads impossible pour le moment" }
        : {
          account, currency: "EUR", eurRate: 1, today: null,
          days: [{ date: "2026-09-29", spend: 100, conversions: 4, revenue: 300, clicks: 40, impressions: 4000 }],
        })),
    };
  },
  summarizeSeries: (series: ClientSeries) => `RÉSUMÉ DES CHIFFRES (${series.accounts.map((a) => a.account.accountId).join("+")})`,
}));
vi.mock("@/lib/client-alerts/evaluate", async (original) => ({
  ...(await original<typeof import("@/lib/client-alerts/evaluate")>()),
  definitionHash: (def: AlertDefinition) => fakeHash(def),
}));
/** What the replay counts as not judged, and why — to stand for a replay that judged (almost) nothing. */
let backtestSkipped: { days: number; kind: string } | null = null;
// The real verdict on a replay (replayVerdict); only the replay itself is replaced.
vi.mock("@/lib/client-alerts/backtest", async (original) => ({
  ...(await original<typeof import("@/lib/client-alerts/backtest")>()),
  backtest: (def: AlertDefinition): Backtest => ({
    days: 30, daysTrue: backtestMessages, checkedDays: 30,
    // As the engine: nothing is judged while an account of the rule cannot be read.
    ...(def.accounts.some((a) => unreadable.has(a.accountId))
      ? { skippedDays: 30, skipKind: "unreadable" as const }
      : { skippedDays: backtestSkipped?.days ?? 0, skipKind: (backtestSkipped?.kind ?? null) as Backtest["skipKind"] }),
    current: 48, min: 31, median: 45, max: 72, notes: [],
    messages: Array.from({ length: backtestMessages }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, value: 70, changePct: null })),
    hash: backtestHashOverride ?? fakeHash(def), ranAt: "2026-09-30T06:00:00.000Z",
  }),
}));
vi.mock("@/lib/client-alerts/slack-dm", () => ({
  dmConfigured: () => slackConfigured,
  slackIdentityOf: (u: { email: string | null; slackEmail: string | null; slackUserId: string | null; slackCheckedAt: Date | null }): SlackIdentity => ({
    email: u.slackEmail ?? u.email, slackUserId: u.slackUserId, checkedAt: u.slackCheckedAt ? u.slackCheckedAt.toISOString() : null,
    status: u.slackUserId ? "found" : u.slackCheckedAt ? "unknown" : "unchecked",
  }),
}));
vi.mock("@/lib/ai-usage", () => ({
  recordAiUsage: async (usage: unknown, ctx: Record<string, unknown>) => { usageRows.push({ usage, ...ctx }); },
  parseUsageEvent: (evt: { type?: string; cost?: number }) => (evt?.type === "usage" ? { costUsd: evt.cost ?? 0 } : null),
}));
vi.mock("@/lib/relay-chat", async (original) => {
  const real = await original<typeof import("@/lib/relay-chat")>();
  return {
    ...real,
    relayStream: async (body: RelayChatBody) => {
      relayCalls.push(body);
      if (relayDown) return Response.json({ error: "IA indisponible (relay unreachable)" }, { status: 502 });
      const sse = ['data: {"type":"delta","text":"Bonjour"}', 'data: {"type":"usage","cost":0.02}', 'data: {"type":"done"}', ""].join("\n\n");
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  };
});

import * as listRoute from "@/app/api/client-alerts/route";
import * as oneRoute from "@/app/api/client-alerts/[id]/route";
import * as assistantRoute from "@/app/api/client-alerts/[id]/assistant/route";
import * as activateRoute from "@/app/api/client-alerts/[id]/activate/route";
import { NOISY_MESSAGES } from "@/lib/client-alerts/types";

/** A route handler always answers; the type of the guards makes the compiler doubt it. */
const sure = <A extends unknown[]>(handler: (...args: A) => Promise<Response | undefined>) => async (...args: A): Promise<Response> => (await handler(...args))!;
const LIST = sure(listRoute.GET), CREATE = sure(listRoute.POST);
const GET = sure(oneRoute.GET), PATCH = sure(oneRoute.PATCH), DELETE = sure(oneRoute.DELETE);
const CHAT_GET = sure(assistantRoute.GET), CHAT_PUT = sure(assistantRoute.PUT), CHAT_POST = sure(assistantRoute.POST);
const ACTIVATE = sure(activateRoute.POST);

/** Consultants are raised to the admin role (lib/roles.ts): what tells them from an admin is baseRole. */
const LEA: Session = { userId: "u-lea", role: "admin", baseRole: "consultant", user: { email: "lea@impulse.test" } };
const SAM: Session = { userId: "u-sam", role: "admin", baseRole: "consultant", user: { email: "sam@impulse.test" } };
const CHEF: Session = { userId: "u-chef", role: "admin", baseRole: "admin", user: { email: "chef@impulse.test" } };
/** What a consultant would be with a narrower access: only the accounts assigned. */
const SCOPED: Session = { userId: "u-scoped", role: "consultant", baseRole: "consultant", user: { email: "scoped@impulse.test" } };

const META: AlertAccountRef = { platform: "meta", accountId: "1234567890", name: "LPEV Meta", currency: "EUR" };
const GOOGLE: AlertAccountRef = { platform: "google", accountId: "9876543210", name: "LPEV Search", currency: "EUR" };

const DUFOUR_GOOGLE: AlertAccountRef = { platform: "google", accountId: "5550001111", name: "Dufour Search", currency: "EUR" };
const ICN_META = "999000111";

const at = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body?: unknown, url = "http://x/api/client-alerts", method = "POST") =>
  new NextRequest(url, body === undefined ? { method } : { method, body: JSON.stringify(body) });
const get = (url = "http://x/api/client-alerts") => new NextRequest(url);
const row = (id: string) => alerts.find((a) => a.id === id)!;

const raw = { label: "CPA au-dessus de 60 €", metric: "cpa", condition: "above", threshold: 60, windowDays: 3 };
const withBlock = (proposal: unknown = raw) => `Je propose 60 €.\n\`\`\`alert\n${JSON.stringify(proposal)}\n\`\`\``;
const thread = (proposal: unknown = raw) => [{ role: "user", content: "Préviens-moi si le CPA dépasse 60 €" }, { role: "assistant", content: withBlock(proposal) }];

async function draft(who: Session = LEA, clientId = "c-lpev"): Promise<string> {
  const before = session;
  session = who;
  const res = await CREATE(req({ alertClientId: clientId }));
  session = before;
  expect(res.status).toBe(201);
  return (await res.json()).alert.id;
}
/** Draft → proposal validated by its creator → active. */
async function active(who: Session = LEA): Promise<string> {
  const id = await draft(who);
  const before = session;
  session = who;
  const res = await ACTIVATE(req({ proposal: raw }), at(id));
  session = before;
  expect(res.status).toBe(200);
  return id;
}

beforeEach(() => {
  alerts.length = 0; events.length = 0; clients.length = 0; users.length = 0; grants.length = 0;
  writes.length = 0; relayCalls.length = 0; usageRows.length = 0; seriesReads.length = 0;
  nextId = 1;
  relayDown = false; seriesDown = false; clientsDown = false; backtestMessages = 2; backtestHashOverride = null; slackConfigured = true;
  unreadable.clear(); backtestSkipped = null;
  session = LEA;
  clients.push(
    { id: "c-lpev", name: "LPEV", accountsJson: JSON.stringify([META, GOOGLE]), gone: false, dormant: false },
    { id: "c-icn", name: "ICN", accountsJson: JSON.stringify([{ platform: "meta", accountId: "999000111", name: "ICN Meta", currency: "EUR" }]), gone: false, dormant: true },
    { id: "c-parti", name: "Parti", accountsJson: JSON.stringify([{ platform: "meta", accountId: "777", name: "Parti", currency: "EUR" }]), gone: true, dormant: false },
    { id: "c-dufour", name: "Dufour", accountsJson: JSON.stringify([DUFOUR_GOOGLE]), gone: false, dormant: false },
  );
  for (const s of [LEA, SAM, CHEF, SCOPED]) users.push({ id: s.userId, email: s.user.email, slackEmail: null, slackUserId: "U0123456789", slackCheckedAt: new Date("2026-09-01T00:00:00Z") });
  grants.push({ userId: SCOPED.userId, platform: "meta", accountId: "act_1234567890" });
  vi.stubEnv("CLIENT_ALERTS_SEND", "1");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

import { lotPlatforms, proposalForClient, readClientIds, readLot } from "@/lib/client-alerts/lot";
import { LOT_MAX_CLIENTS } from "@/lib/client-alerts/types";

const LOT = ["c-lpev", "c-icn", "c-dufour"];

async function lotDraft(ids: string[] = LOT, who: Session = LEA): Promise<string> {
  const before = session;
  session = who;
  const res = await CREATE(req({ alertClientIds: ids }));
  session = before;
  expect(res.status).toBe(201);
  return (await res.json()).alert.id;
}
const lotRows = (lead: string) => alerts.filter((a) => a.groupId === lead);
const rowOf = (lead: string, clientId: string) => lotRows(lead).find((a) => a.alertClientId === clientId);
const accountsOf = (r: Row | undefined) => JSON.parse(String(r?.definitionJson ?? "{}")).accounts as AlertAccountRef[] | undefined;

// ── Pure helpers ──────────────────────────────────────────────────────────

describe("lots — lecture de la demande", () => {
  it("lit un ou plusieurs clients, sans doublon ni vide", () => {
    expect(readClientIds({ alertClientId: " c-lpev " })).toEqual(["c-lpev"]);
    expect(readClientIds({ alertClientIds: ["a", "b", "a", "", 3, " b "] })).toEqual(["a", "b"]);
    expect(readClientIds({ alertClientIds: [] })).toBeNull();
    expect(readClientIds(null)).toBeNull();
    expect(readLot('["a","a","b"]')).toEqual(["a", "b"]);
    expect(readLot("pas du json")).toEqual([]);
  });

  it("ne garde des comptes écrits par l'IA que leur plateforme", () => {
    expect(lotPlatforms(undefined)).toBeNull();
    expect(lotPlatforms([])).toBeNull();
    expect(lotPlatforms([{ platform: "google", accountId: "123" }, { platform: "meta" }, { platform: "inconnue" }])).toEqual(["meta", "google"]);
    expect(lotPlatforms([{ platform: "inconnue" }])).toBeNull();
  });

  it("donne à chaque client ses propres comptes, ou rien s'il n'a pas la plateforme", () => {
    const rule = { ...raw, accounts: [{ platform: "meta", accountId: "volé" }] };
    expect(proposalForClient(rule, null, [META, GOOGLE])?.accounts).toEqual([
      { platform: "meta", accountId: META.accountId }, { platform: "google", accountId: GOOGLE.accountId },
    ]);
    expect(proposalForClient(rule, ["meta"], [META, GOOGLE])?.accounts).toEqual([{ platform: "meta", accountId: META.accountId }]);
    expect(proposalForClient(rule, ["meta"], [DUFOUR_GOOGLE])).toBeNull();
    expect(proposalForClient(rule, null, [META])).toMatchObject({ metric: "cpa", threshold: 60 });
  });
});

// ── Creating a lot ────────────────────────────────────────────────────────

describe("lots — création", () => {
  it("ouvre une seule conversation qui tient les clients du lot, et la reprend si rien n'y a été écrit", async () => {
    const id = await lotDraft();
    expect(alerts).toHaveLength(1);
    expect(row(id)).toMatchObject({ alertClientId: "c-lpev", clientName: "LPEV", groupId: id, groupJson: JSON.stringify(LOT), status: "draft" });

    const again = await CREATE(req({ alertClientIds: LOT }));
    expect(again.status).toBe(200);
    expect((await again.json()).alert.id).toBe(id);
    expect(alerts).toHaveLength(1);

    // A single client is not a lot, and does not take up the lot's draft.
    const single = await draft(LEA, "c-lpev");
    expect(single).not.toBe(id);
    expect(row(single).groupJson).toBe("[]");

    const list = await (await LIST(get())).json();
    expect(list.alerts.find((a: { id: string }) => a.id === id)).toMatchObject({ lotId: id, lotSize: 3 });
    expect(list.alerts.find((a: { id: string }) => a.id === single)).toMatchObject({ lotId: null, lotSize: 0 });
  });

  it("refuse un lot trop grand, un client disparu ou hors de portée — sans rien écrire", async () => {
    const tooMany = Array.from({ length: LOT_MAX_CLIENTS + 1 }, (_, i) => `c-${i}`);
    expect((await CREATE(req({ alertClientIds: tooMany }))).status).toBe(400);
    expect((await CREATE(req({ alertClientIds: ["c-lpev", "c-parti"] }))).status).toBe(404);
    expect((await CREATE(req({ alertClientIds: ["c-lpev", "c-inconnu"] }))).status).toBe(404);
    session = SCOPED;
    const denied = await CREATE(req({ alertClientIds: ["c-lpev", "c-icn"] }));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toContain("ICN");
    expect(alerts).toEqual([]);
  });
});

// ── Conversation ──────────────────────────────────────────────────────────

describe("lots — conversation", () => {
  it("vérifie chaque proposition client par client, sur les comptes de chacun", async () => {
    const id = await lotDraft();
    const res = await CHAT_PUT(req({ messages: thread() }), at(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lot.map((c: { clientName: string }) => c.clientName)).toEqual(["LPEV", "ICN", "Dufour"]);
    const check = body.checks.m1;
    expect(check.ok).toBe(true);
    expect(check.lot.platforms).toBeNull();
    expect(check.lot.clients.map((c: { clientName: string; ok: boolean }) => [c.clientName, c.ok])).toEqual([["LPEV", true], ["ICN", true], ["Dufour", true]]);
    // Every client read on its own accounts, never together.
    expect(seriesReads).toContainEqual([META, GOOGLE]);
    expect(seriesReads).toContainEqual([DUFOUR_GOOGLE]);
    expect(seriesReads.some((r) => r.length === 4)).toBe(false);
  });

  it("limite à une plateforme sans jamais reprendre un identifiant écrit par l'IA", async () => {
    const id = await lotDraft();
    const body = await (await CHAT_PUT(req({ messages: thread({ ...raw, accounts: [{ platform: "meta", accountId: DUFOUR_GOOGLE.accountId }] }) }), at(id))).json();
    const check = body.checks.m1;
    expect(check.ok).toBe(true);
    expect(check.lot.platforms).toEqual(["meta"]);
    expect(check.proposal.accounts).toEqual([META]);
    const dufour = check.lot.clients.find((c: { clientName: string }) => c.clientName === "Dufour");
    expect(dufour).toMatchObject({ ok: false });
    expect(dufour.error).toContain("Meta");
  });

  it("refuse une proposition qu'aucun client ne peut prendre, avec la raison de chacun", async () => {
    const id = await lotDraft();
    const body = await (await CHAT_PUT(req({ messages: thread({ ...raw, metric: "inconnue" }) }), at(id))).json();
    const check = body.checks.m1;
    expect(check.ok).toBe(false);
    expect(check.retry).toBeUndefined();
    expect(check.errors).toHaveLength(3);
    expect(check.errors[0]).toMatch(/^LPEV : /);
    expect(body.proposals.m1).toBe("invalid");
  });

  it("attend, sans refuser, quand les chiffres de tous les clients sont illisibles", async () => {
    const id = await lotDraft();
    seriesDown = true;
    const body = await (await CHAT_PUT(req({ messages: thread() }), at(id))).json();
    expect(body.checks.m1).toMatchObject({ ok: false, retry: true });
    expect(body.figures).toEqual({ ok: false });
  });

  it("donne à l'IA les consignes du lot et les chiffres de chaque client", async () => {
    const id = await lotDraft();
    const res = await CHAT_POST(req({ messages: [{ role: "user", content: "Préviens-moi si la dépense chute de moitié" }] }), at(id));
    expect(res.status).toBe(200);
    await res.text();
    const call = relayCalls[0];
    expect(call.systemPrompt).toContain("LOT DE PLUSIEURS CLIENTS");
    expect(call.systemPrompt).toContain('CLIENTS DU LOT (3) : "LPEV", "ICN", "Dufour"');
    expect(call.turnContext).toContain("Lot de 3 clients");
    for (const name of ["LPEV", "ICN", "Dufour"]) expect(call.turnContext).toContain(`## ${name}`);
    expect(usageRows[0]).toMatchObject({ clientName: "LPEV + 2 client(s)" });
  });
});

// ── Activation ────────────────────────────────────────────────────────────

describe("lots — mise en service", () => {
  it("met une alerte en service par client, chacune sur ses comptes, puis les met à jour sans en créer d'autres", async () => {
    const id = await lotDraft();
    const res = await ACTIVATE(req({ proposal: raw }), at(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alerts).toHaveLength(3);
    expect(body.alert.id).toBe(id);
    expect(lotRows(id)).toHaveLength(3);
    for (const r of lotRows(id)) expect(r).toMatchObject({ status: "active", createdById: LEA.userId, groupId: id });
    expect(accountsOf(rowOf(id, "c-lpev"))).toEqual([META, GOOGLE]);
    expect(accountsOf(rowOf(id, "c-dufour"))).toEqual([DUFOUR_GOOGLE]);
    expect(accountsOf(rowOf(id, "c-icn"))?.map((a) => a.accountId)).toEqual([ICN_META]);
    expect(rowOf(id, "c-dufour")?.clientName).toBe("Dufour");
    // Only the lead holds the conversation and the lot.
    expect(rowOf(id, "c-dufour")?.groupJson).toBe("[]");

    const dufour = rowOf(id, "c-dufour")!.id;
    const again = await ACTIVATE(req({ proposal: { ...raw, threshold: 80 } }), at(id));
    expect(again.status).toBe(200);
    expect(lotRows(id)).toHaveLength(3);
    expect(rowOf(id, "c-dufour")!.id).toBe(dufour);
    expect(JSON.parse(String(rowOf(id, "c-dufour")!.definitionJson)).threshold).toBe(80);
  });

  it("laisse de côté un client sans la plateforme demandée, et retire l'ancienne règle de son alerte", async () => {
    const id = await lotDraft();
    await ACTIVATE(req({ proposal: raw }), at(id));
    const res = await ACTIVATE(req({ proposal: raw, platforms: ["meta"] }), at(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alerts).toHaveLength(2);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]).toMatch(/^Dufour : /);
    expect(accountsOf(rowOf(id, "c-lpev"))).toEqual([META]);
    expect(rowOf(id, "c-dufour")).toMatchObject({ status: "review" });
    expect(String(rowOf(id, "c-dufour")!.lastNote)).toContain("nouvelle règle du lot");
  });

  it("ne touche pas l'alerte d'un client dont les chiffres sont seulement illisibles pour le moment", async () => {
    const id = await lotDraft();
    await ACTIVATE(req({ proposal: raw }), at(id));
    const before = JSON.stringify(rowOf(id, "c-dufour"));
    unreadable.add(DUFOUR_GOOGLE.accountId);
    const res = await ACTIVATE(req({ proposal: { ...raw, threshold: 90 } }), at(id));
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toHaveLength(1);
    expect(JSON.stringify(rowOf(id, "c-dufour"))).toBe(before);
    expect(JSON.parse(String(rowOf(id, "c-lpev")!.definitionJson)).threshold).toBe(90);
  });

  it("demande confirmation pour une règle bruyante, en nommant les clients", async () => {
    const id = await lotDraft();
    backtestMessages = NOISY_MESSAGES + 1;
    const res = await ACTIVATE(req({ proposal: raw }), at(id));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.needsConfirm).toBe(true);
    expect(body.noisyClients).toEqual(["LPEV", "ICN", "Dufour"]);
    expect(lotRows(id).every((r) => r.status === "draft")).toBe(true);
    expect(lotRows(id)).toHaveLength(1);

    expect((await ACTIVATE(req({ proposal: raw, confirmNoisy: true }), at(id))).status).toBe(200);
    expect(lotRows(id)).toHaveLength(3);
  });

  it("n'enregistre rien quand aucun client ne prend la règle", async () => {
    const id = await lotDraft();
    const res = await ACTIVATE(req({ proposal: { ...raw, metric: "inconnue" } }), at(id));
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toHaveLength(3);
    expect(lotRows(id)).toHaveLength(1);
    expect(row(id).status).toBe("draft");
  });

  it("reste fermée à un autre consultant", async () => {
    const id = await lotDraft();
    session = SAM;
    expect((await ACTIVATE(req({ proposal: raw }), at(id))).status).toBe(404);
    expect((await CHAT_PUT(req({ messages: thread() }), at(id))).status).toBe(404);
    expect(lotRows(id)).toHaveLength(1);
  });
});

describe("lots — une alerte du lot", () => {
  it("se lit, se met en pause seule, et la conversation reste celle du lot", async () => {
    const id = await lotDraft();
    await CHAT_PUT(req({ messages: thread() }), at(id));
    await ACTIVATE(req({ proposal: raw }), at(id));
    const icn = rowOf(id, "c-icn")!.id;

    const one = await (await GET(get(), at(icn))).json();
    expect(one.alert).toMatchObject({ id: icn, lotId: id, lotSize: 0, clientName: "ICN" });

    expect((await PATCH(req({ action: "pause" }), at(icn))).status).toBe(200);
    expect(row(icn).status).toBe("paused");
    expect(lotRows(id).filter((r) => r.status === "active")).toHaveLength(2);

    const chat = await (await CHAT_GET(get(), at(id))).json();
    expect(chat.messages).toHaveLength(2);
    expect(chat.lot).toHaveLength(3);
    expect(chat.checks.m1.lot.clients).toHaveLength(3);
  });
});

// ── Deleting ──────────────────────────────────────────────────────────────

describe("lots — suppression", () => {
  it("supprimer la conversation du lot supprime tout le lot", async () => {
    const id = await lotDraft();
    const single = await active();
    await ACTIVATE(req({ proposal: raw }), at(id));
    const res = await DELETE(get(), at(id));
    expect((await res.json()).deleted).toBe(3);
    expect(lotRows(id)).toEqual([]);
    expect(row(single)).toBeDefined();
  });

  it("supprimer l'alerte d'un client la retire du lot : la validation suivante ne la recrée pas", async () => {
    const id = await lotDraft();
    await ACTIVATE(req({ proposal: raw }), at(id));
    const dufour = rowOf(id, "c-dufour")!.id;
    expect((await (await DELETE(get(), at(dufour))).json()).deleted).toBe(1);
    expect(readLot(String(row(id).groupJson))).toEqual(["c-lpev", "c-icn"]);

    await ACTIVATE(req({ proposal: { ...raw, threshold: 70 } }), at(id));
    expect(rowOf(id, "c-dufour")).toBeUndefined();
    expect(lotRows(id)).toHaveLength(2);
  });
});

// ── Review fixes ──────────────────────────────────────────────────────────

describe("lots — après relecture", () => {
  it("reprend le brouillon du même lot coché dans un autre ordre, à jour du client", async () => {
    const id = await lotDraft();
    clients.find((c) => c.id === "c-dufour")!.name = "Dufour & Fils";
    const again = await CREATE(req({ alertClientIds: ["c-dufour", "c-lpev", "c-icn"] }));
    expect(again.status).toBe(200);
    expect((await again.json()).alert.id).toBe(id);
    expect(alerts).toHaveLength(1);
    expect(row(id)).toMatchObject({ alertClientId: "c-dufour", clientName: "Dufour & Fils", groupJson: JSON.stringify(["c-dufour", "c-lpev", "c-icn"]) });
    expect(JSON.parse(String(row(id).accountsJson))).toEqual([DUFOUR_GOOGLE]);
  });

  it("laisse en pause le client que le consultant avait mis en pause, en lui donnant la nouvelle règle", async () => {
    const id = await lotDraft();
    await ACTIVATE(req({ proposal: raw }), at(id));
    const icn = rowOf(id, "c-icn")!.id;
    expect((await PATCH(req({ action: "pause" }), at(icn))).status).toBe(200);
    expect((await ACTIVATE(req({ proposal: { ...raw, threshold: 75 } }), at(id))).status).toBe(200);
    expect(row(icn).status).toBe("paused");
    expect(JSON.parse(String(row(icn).definitionJson)).threshold).toBe(75);
    expect(rowOf(id, "c-lpev")!.status).toBe("active");
  });

  it("dit à l'IA les plateformes de la règle validée, et « Remplacer » même si le client de la conversation n'est pas concerné", async () => {
    // Dufour (Google seulement) tient la conversation ; la règle Meta ne le concerne pas.
    const id = await lotDraft(["c-dufour", "c-icn", "c-lpev"]);
    const res = await ACTIVATE(req({ proposal: raw, platforms: ["meta"] }), at(id));
    expect(res.status).toBe(200);
    expect(row(id).status).toBe("draft");
    expect(row(id).groupPlatforms).toBe("meta");

    const chat = await (await CHAT_GET(get(), at(id))).json();
    expect(chat.lotInService).toBe(true);

    await (await CHAT_POST(req({ messages: [{ role: "user", content: "Monte le seuil à 80 €" }] }), at(id))).text();
    const ctx = String(relayCalls.at(-1)!.turnContext);
    expect(ctx).toContain('"accounts":[{"platform":"meta"}]');
    expect(ctx).toContain("en service");

    // Validée ensuite sur tous les comptes : plus de plateforme dans ce que lit l'IA.
    expect((await ACTIVATE(req({ proposal: raw }), at(id))).status).toBe(200);
    expect(row(id).groupPlatforms).toBe("");
    await (await CHAT_POST(req({ messages: [{ role: "user", content: "Et maintenant ?" }] }), at(id))).text();
    expect(String(relayCalls.at(-1)!.turnContext)).not.toContain('"platform":"meta"}]');
  });

  it("un lot réduit à un client redevient une alerte ordinaire", async () => {
    const id = await lotDraft(["c-lpev", "c-dufour"]);
    await ACTIVATE(req({ proposal: raw }), at(id));
    await DELETE(get(), at(rowOf(id, "c-dufour")!.id));
    expect(row(id)).toMatchObject({ groupId: null, groupJson: "[]", groupPlatforms: "" });
    const list = await (await LIST(get())).json();
    expect(list.alerts.find((a: { id: string }) => a.id === id)).toMatchObject({ lotId: null, lotSize: 0 });
  });

  it("deux validations du même lot en même temps : la seconde est refusée sans rien casser", async () => {
    const id = await lotDraft();
    const { prisma } = await import("@/lib/prisma");
    const create = vi.spyOn(prisma.clientAlert, "create").mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const res = await ACTIVATE(req({ proposal: raw }), at(id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/autre onglet/);
    create.mockRestore();
  });
});
