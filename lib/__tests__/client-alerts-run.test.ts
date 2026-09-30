import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The REAL run, store, evaluation and state machine, over a Prisma held in
 * memory. What is replaced: the read of the platforms (series.ts), the text
 * of the message and the Slack delivery (lot B). No database, no network,
 * and never the real date.
 */
const h = vi.hoisted(() => {
  type Rec = Record<string, unknown>;
  const alerts: Rec[] = [];
  const events: Rec[] = [];
  const clients: Rec[] = [];
  const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

  function matches(row: Rec, where: Rec | undefined): boolean {
    return Object.entries(where ?? {}).every(([key, cond]) => {
      if (cond === undefined) return true;
      if (key === "alert") {
        const alert = alerts.find((a) => a.id === row.alertId);
        return !!alert && matches(alert, cond as Rec);
      }
      const value = row[key] ?? null;
      if (cond === null || typeof cond !== "object" || cond instanceof Date) return same(value, cond);
      const c = cond as Rec;
      if ("in" in c) return (c.in as unknown[]).some((v) => same(v, value));
      if ("gte" in c) return value instanceof Date && value.getTime() >= (c.gte as Date).getTime();
      throw new Error(`fake prisma: filter not supported on ${key}`);
    });
  }
  const pick = (row: Rec, select?: Rec): Rec => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row });
  function patch(row: Rec, data: Rec): void {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      const inc = value && typeof value === "object" && !(value instanceof Date) ? (value as Rec).increment : undefined;
      row[key] = inc !== undefined ? Number(row[key] ?? 0) + Number(inc) : value;
    }
  }
  /** orderBy as Prisma takes it: [{ field: "asc" } | { field: { sort, nulls } }]. */
  function sorted(rows: Rec[], orderBy: Array<Record<string, string | { sort: string; nulls?: string }>> = []): Rec[] {
    const time = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));
    return [...rows].sort((a, b) => {
      for (const entry of orderBy) {
        const [field, spec] = Object.entries(entry)[0];
        const dir = (typeof spec === "string" ? spec : spec.sort) === "desc" ? -1 : 1;
        const nullsFirst = typeof spec !== "string" && spec.nulls === "first";
        const x = a[field] ?? null, y = b[field] ?? null;
        if (x === null || y === null) {
          if (x === y) continue;
          return (x === null) === nullsFirst ? -1 : 1;
        }
        if (time(x) !== time(y)) return (time(x) - time(y)) * dir;
      }
      return 0;
    });
  }
  function table(rows: Rec[]) {
    return {
      async findMany({ where, orderBy, select }: { where?: Rec; orderBy?: Parameters<typeof sorted>[1]; select?: Rec } = {}) {
        return sorted(rows.filter((r) => matches(r, where)), orderBy).map((r) => pick(r, select));
      },
      async findUnique({ where, select }: { where: Rec; select?: Rec }) {
        const row = rows.find((r) => matches(r, where));
        return row ? pick(row, select) : null;
      },
      async updateMany({ where, data }: { where?: Rec; data: Rec }) {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => patch(r, data));
        return { count: hit.length };
      },
      async update({ where, data, select }: { where: Rec; data: Rec; select?: Rec }) {
        const row = rows.find((r) => matches(r, where));
        if (!row) throw new Error("fake prisma: record not found");
        patch(row, data);
        return pick(row, select);
      },
      async create({ data, select }: { data: Rec; select?: Rec }) {
        const row: Rec = { id: `e${rows.length + 1}`, notifiedAt: null, notifyError: null, batchId: null, ...data };
        rows.push(row);
        return pick(row, select);
      },
    };
  }
  const db = {
    clientAlert: table(alerts),
    clientAlertEvent: table(events),
    alertClient: table(clients),
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> { return fn(db); },
  };
  /** As lib/client-alerts/slack-dm.ts: words for the consultant, the technical cause apart. */
  class SlackDmError extends Error {
    readonly detail: string;
    constructor(message: string, detail: string = message) { super(message); this.name = "SlackDmError"; this.detail = detail; }
  }
  return {
    alerts, events, clients, db, SlackDmError,
    read: vi.fn(),
    line: vi.fn(),
    text: vi.fn(),
    configured: vi.fn(),
    identity: vi.fn(),
    send: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: h.db }));
vi.mock("@/lib/client-alerts/series", () => ({ readClientSeries: h.read }));
vi.mock("@/lib/client-alerts/message", () => ({ buildAlertLine: h.line, buildDmText: h.text }));
vi.mock("@/lib/client-alerts/slack-dm", () => ({ dmConfigured: h.configured, resolveSlackIdentity: h.identity, sendSlackDm: h.send, SlackDmError: h.SlackDmError }));

import { clientProblem, FLOOD, HELD, isDue, MAX_LINES_PER_DM, runClientAlerts, slotOf } from "@/lib/client-alerts/run";
import * as route from "@/app/api/cron/client-alerts/route";
import {
  MAX_DELIVERY_FAILURES, MAX_DM_PER_RUN, MAX_DM_PER_USER_PER_DAY,
  type AccountSeries, type AlertAccountRef, type AlertDefinition, type ClientSeries, type Evaluation, type SeriesPoint,
} from "@/lib/client-alerts/types";

// A Tuesday, ten past the first slot (06:00 UTC = 08:10 in Paris).
const NOW = new Date("2026-09-29T06:10:00Z");
const UNTIL = "2026-09-28";
const at = (iso: string) => new Date(iso);

/** Spend of the last full day, per account id; 100 € every other day. Above 150 € the default alert triggers. */
const lastDay = new Map<string, number>();
/** Accounts the platforms cannot read. */
const unreadable = new Set<string>();
/** Day in progress, per account id. */
const today = new Map<string, AccountSeries["today"]>();

function seriesOf(ref: AlertAccountRef): AccountSeries {
  if (unreadable.has(ref.accountId)) return { account: ref, currency: "EUR", eurRate: 1, days: [], today: null, error: "lecture impossible — relay 502" };
  const days: SeriesPoint[] = [];
  for (let back = 94; back >= 0; back--) {
    const date = new Date(Date.parse(`${UNTIL}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    days.push({ date, spend: back === 0 ? lastDay.get(ref.accountId) ?? 100 : 100, conversions: 2, revenue: null, clicks: 10, impressions: 1000 });
  }
  return { account: ref, currency: "EUR", eurRate: 1, days, today: today.get(ref.accountId) ?? null };
}

const account = (id: string, platform: "meta" | "google" = "meta"): AlertAccountRef => ({ platform, accountId: id, name: `Compte ${id}`, currency: "EUR" });
const definition = (over: Partial<AlertDefinition> = {}): AlertDefinition => ({
  version: 1, label: "Dépense haute", accounts: [account("act_1")], metric: "spend", aggregation: "combined", condition: "above", threshold: 150,
  windowDays: 1, compare: "previous_window", guards: {}, checks: "4x", weekdaysOnly: false, cooldownHours: 72, remind: false, explanation: "",
  ...over,
});

let n = 0;
/** One active alert on its own account (`act_<id>`), unless told otherwise. */
function seed(id: string, over: Record<string, unknown> = {}, def: Partial<AlertDefinition> = {}): Record<string, unknown> {
  const d = definition({ accounts: [account(`act_${id}`)], ...def });
  const row = {
    id, createdById: "u1", createdByEmail: "lea@impulse.test", alertClientId: null, clientName: `Client ${id}`, label: `Alerte ${id}`,
    accountsJson: JSON.stringify(d.accounts), definitionJson: JSON.stringify(d), status: "active", armed: true,
    lastCheckedAt: null, lastTriggeredAt: null, lastValue: null, lastNote: null, consecutiveFailures: 0,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, n++)), ...over,
  };
  h.alerts.push(row);
  return row;
}
/** The last full day of this alert's account is above the threshold. */
const high = (...ids: string[]) => ids.forEach((id) => lastDay.set(`act_${id}`, 200));
const alert = (id: string) => h.alerts.find((a) => a.id === id)!;
const eventsOf = (id: string) => h.events.filter((e) => e.alertId === id);
const sendingOn = () => { process.env.CLIENT_ALERTS_SEND = "1"; };

const ENV_KEYS = ["CLIENT_ALERTS_SEND", "NEXTAUTH_URL", "CRON_SECRET", "CLIENT_ALERTS_CRON"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  h.alerts.length = 0; h.events.length = 0; h.clients.length = 0;
  lastDay.clear(); unreadable.clear(); today.clear();
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  h.read.mockReset().mockImplementation(async (accounts: AlertAccountRef[], opts: { now?: Date }): Promise<ClientSeries> => ({
    readAt: (opts.now ?? NOW).toISOString(), until: UNTIL, accounts: accounts.map(seriesOf),
  }));
  h.line.mockReset().mockImplementation(({ clientName, kind }: { clientName: string; kind: string }) => `${clientName} [${kind}]`);
  h.text.mockReset().mockImplementation((lines: string[], extra: number, pageUrl: string | null) => JSON.stringify({ lines, extra, pageUrl }));
  h.configured.mockReset().mockReturnValue(true);
  h.identity.mockReset().mockImplementation(async (userId: string) => ({ email: `${userId}@impulse.test`, slackUserId: `U${userId.toUpperCase()}0000000`, checkedAt: null, status: "found" }));
  h.send.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("what is due", () => {
  it("reads the slot from the UTC hour of the firing", () => {
    expect(slotOf(at("2026-09-29T06:10:00Z"))).toBe(0);
    expect(slotOf(at("2026-09-29T09:59:00Z"))).toBe(1);
    expect(slotOf(at("2026-09-29T12:00:00Z"))).toBe(2);
    expect(slotOf(at("2026-09-29T15:10:00Z"))).toBe(3);
    expect(slotOf(at("2026-09-29T07:10:00Z"))).toBeNull();
  });

  it("checks 1x at the first slot, 2x at the first and third, 4x at every slot", async () => {
    // Every alert was checked at each of its own slots so far today.
    const passes: Array<[string, string[]]> = [
      ["2026-09-29T06:10:00Z", ["once", "twice", "four"]],
      ["2026-09-29T09:10:00Z", ["four"]],
      ["2026-09-29T12:10:00Z", ["twice", "four"]],
      ["2026-09-29T15:10:00Z", ["four"]],
    ];
    seed("once", {}, { checks: "1x" });
    seed("twice", {}, { checks: "2x" });
    seed("four", {}, { checks: "4x" });
    for (const [iso, expected] of passes) {
      const now = at(iso);
      const summary = await runClientAlerts({ now });
      expect(summary.slot, iso).toBe(slotOf(now));
      expect(summary.checked, iso).toBe(expected.length);
      expect(h.alerts.filter((a) => same(a.lastCheckedAt, now)).map((a) => a.id), iso).toEqual(expected);
    }
  });

  it("takes every active alert at an hour that is no slot, and when told no slot", async () => {
    seed("once", { lastCheckedAt: at("2026-09-29T06:10:00Z") }, { checks: "1x" });
    seed("twice", { lastCheckedAt: at("2026-09-29T06:10:00Z") }, { checks: "2x" });
    const manual = await runClientAlerts({ now: at("2026-09-29T10:30:00Z") });
    expect(manual.slot).toBeNull();
    expect(manual.checked).toBe(2);
    // At the hour of the second slot nothing is due for them; `slot: null` takes them anyway.
    expect((await runClientAlerts({ now: at("2026-09-29T09:10:00Z") })).checked).toBe(0);
    expect((await runClientAlerts({ now: at("2026-09-29T09:10:00Z"), slot: null })).checked).toBe(2);
  });

  it("follows an explicit slot rather than the hour", async () => {
    seed("twice", { lastCheckedAt: at("2026-09-29T06:10:00Z") }, { checks: "2x" });
    const summary = await runClientAlerts({ now: at("2026-09-29T09:10:00Z"), slot: 2 });
    expect(summary.slot).toBe(2);
    expect(summary.checked).toBe(1);
  });

  it("catches up an alert that missed a slot of its own earlier today", () => {
    const d = { checks: "1x" as const, weekdaysOnly: false };
    const now = at("2026-09-29T09:10:00Z");
    // Last checked yesterday: the first slot of today was missed.
    expect(isDue(d, at("2026-09-28T06:10:00Z"), 1, now)).toBe(true);
    expect(isDue(d, null, 1, now)).toBe(true);
    // Checked this morning: nothing to catch up.
    expect(isDue(d, at("2026-09-29T06:10:00Z"), 1, now)).toBe(false);
    // A later slot of its own is not a missed one.
    expect(isDue({ checks: "2x", weekdaysOnly: false }, at("2026-09-29T06:10:00Z"), 1, now)).toBe(false);
  });

  it("leaves weekdaysOnly alerts alone on Saturday and Sunday, Paris time", async () => {
    seed("week", {}, { weekdaysOnly: true });
    seed("always", {}, { weekdaysOnly: false });
    for (const iso of ["2026-09-26T06:10:00Z", "2026-09-27T06:10:00Z"]) {
      const now = at(iso);
      await runClientAlerts({ now });
      expect(same(alert("always").lastCheckedAt, now), iso).toBe(true);
      expect(alert("week").lastCheckedAt, iso).toBeNull();
      // A manual pass does not check them on a weekend either.
      await runClientAlerts({ now, slot: null });
      expect(alert("week").lastCheckedAt, iso).toBeNull();
    }
    // Sunday 22:30 UTC is already Monday in Paris.
    expect(isDue({ checks: "4x", weekdaysOnly: true }, null, null, at("2026-09-27T22:30:00Z"))).toBe(true);
    // Friday 22:30 UTC is already Saturday in Paris.
    expect(isDue({ checks: "4x", weekdaysOnly: true }, null, null, at("2026-09-25T22:30:00Z"))).toBe(false);
    await runClientAlerts({ now: at("2026-09-28T06:10:00Z") });
    expect(alert("week").lastCheckedAt).toEqual(at("2026-09-28T06:10:00Z"));
  });

  it("only takes active alerts whose definition reads", async () => {
    seed("draft", { status: "draft", definitionJson: "{}" });
    seed("paused", { status: "paused" });
    seed("review", { status: "review" });
    seed("error", { status: "error" });
    seed("broken", { definitionJson: "{}" });
    seed("good");
    high("draft", "paused", "review", "error", "broken", "good");
    const summary = await runClientAlerts({ now: NOW });
    expect(summary.checked).toBe(1);
    expect(h.events.map((e) => e.alertId)).toEqual(["good"]);
    expect(h.alerts.filter((a) => a.lastCheckedAt !== null).map((a) => a.id)).toEqual(["good"]);
  });

  it("restricts the pass to the alerts asked for", async () => {
    seed("a"); seed("b"); seed("c");
    const summary = await runClientAlerts({ now: NOW, only: ["b"] });
    expect(summary.checked).toBe(1);
    expect(h.alerts.filter((a) => a.lastCheckedAt !== null).map((a) => a.id)).toEqual(["b"]);
  });

  it("starts with the alerts that waited the longest, never checked first", async () => {
    seed("recent", { lastCheckedAt: at("2026-09-28T15:10:00Z") });
    seed("old", { lastCheckedAt: at("2026-09-27T06:10:00Z") });
    seed("never");
    await runClientAlerts({ now: NOW });
    expect(h.read.mock.calls.map((c) => (c[0] as AlertAccountRef[])[0].accountId)).toEqual(["act_never", "act_old", "act_recent"]);
  });

  it("stops taking alerts once its time is up and says how many wait", async () => {
    let clock = NOW.getTime();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    for (const id of ["a", "b", "c", "d", "e", "f"]) seed(id);
    // Every read of the platforms takes 200 s: the budget of 270 s is gone after the second.
    const read = h.read.getMockImplementation()!;
    h.read.mockImplementation(async (...args: unknown[]) => { clock += 200_000; return read(...args); });
    const summary = await runClientAlerts({ now: NOW });
    expect(summary.checked).toBe(2);
    expect(h.alerts.filter((a) => a.lastCheckedAt !== null).map((a) => a.id)).toEqual(["a", "b"]);
    expect(summary.errors.join(" ")).toMatch(/4 alertes non vérifiées/);
  });
});

describe("an alert whose accounts left its client", () => {
  const client = (over: Record<string, unknown> = {}) => h.clients.push({
    id: "cl1", name: "Maison Durand", gone: false,
    accountsJson: JSON.stringify([account("act_1"), account("777", "google")]), ...over,
  });
  const mine = { accounts: [account("act_1"), account("777", "google")] };

  it("is evaluated while every account is still among those of the client", async () => {
    client();
    seed("a", { alertClientId: "cl1" }, mine);
    const summary = await runClientAlerts({ now: NOW });
    expect(summary.checked).toBe(1);
    expect(alert("a").status).toBe("active");
    expect(alert("a").lastCheckedAt).toEqual(NOW);
  });

  it("goes to review, with the reason, and is not evaluated", async () => {
    client({ accountsJson: JSON.stringify([account("act_1")]) });
    seed("a", { alertClientId: "cl1" }, mine);
    lastDay.set("act_1", 900);
    const summary = await runClientAlerts({ now: NOW });
    expect(alert("a").status).toBe("review");
    expect(alert("a").lastNote).toMatch(/Google Ads « Compte 777 » ne fait plus partie du client « Maison Durand »/);
    expect(summary.checked).toBe(0);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    // Armed as it was: nothing was judged.
    expect(alert("a").armed).toBe(true);
  });

  it("goes to review when the client is gone or no longer exists", async () => {
    client({ gone: true });
    seed("gone", { alertClientId: "cl1" }, mine);
    seed("orphan", { alertClientId: "cl-deleted" }, mine);
    await runClientAlerts({ now: NOW });
    expect(alert("gone").status).toBe("review");
    expect(alert("gone").lastNote).toMatch(/Maison Durand/);
    expect(alert("orphan").status).toBe("review");
    expect(alert("orphan").lastNote).toMatch(/n'existe plus/);
    expect(h.read).not.toHaveBeenCalled();
  });

  it("does not mind how the ids are written, and does not look for a client when the alert has none", () => {
    const state = { name: "Maison Durand", gone: false, accounts: [account("100"), account("123-456-7890", "google")] };
    expect(clientProblem([account("act_100"), account("1234567890", "google")], "Maison Durand", state)).toBeNull();
    expect(clientProblem([account("100", "google")], "Maison Durand", state)).toMatch(/ne fait plus partie/);
  });

  it("evaluates an alert that has no client", async () => {
    seed("free", { alertClientId: null });
    expect((await runClientAlerts({ now: NOW })).checked).toBe(1);
  });
});

describe("evaluation and state", () => {
  it("reads each account once per pass, fresh, whatever the number of alerts on it", async () => {
    const shared = [account("act_1"), account("777", "google")];
    seed("a", {}, { accounts: shared });
    seed("b", {}, { accounts: shared, threshold: 500 });
    seed("c", {}, { accounts: [account("act_1")] });
    const summary = await runClientAlerts({ now: NOW });
    expect(summary.checked).toBe(3);
    const read = h.read.mock.calls.flatMap((c) => (c[0] as AlertAccountRef[]).map((a) => a.accountId)).sort();
    expect(read).toEqual(["777", "act_1"]);
    for (const call of h.read.mock.calls) expect(call[1]).toEqual({ now: NOW, fresh: true });
  });

  it("records a trigger: one event, the alert disarmed, the silence started", async () => {
    seed("a");
    high("a");
    const summary = await runClientAlerts({ now: NOW });
    expect(summary).toMatchObject({ checked: 1, triggered: 1, skipped: 0 });
    expect(alert("a")).toMatchObject({ armed: false, lastTriggeredAt: NOW, lastCheckedAt: NOW, lastValue: 200, lastNote: null, status: "active" });
    expect(h.events).toHaveLength(1);
    const event = h.events[0];
    expect(event).toMatchObject({ alertId: "a", kind: "trigger", value: 200, threshold: 150, message: "Client a [trigger]", triggeredAt: NOW });
    const detail = JSON.parse(event.detailJson as string) as Evaluation;
    expect(detail.status).toBe("triggered");
    expect(detail.asOf).toBe(UNTIL);
    expect(detail.parts.map((p) => p.scope)).toEqual(["combined", "meta"]);
    // The line of the message was built from the evaluation that triggered.
    expect(h.line).toHaveBeenCalledWith(expect.objectContaining({ clientName: "Client a", kind: "trigger", evaluation: expect.objectContaining({ status: "triggered", value: 200 }) }));
  });

  it("re-arms on a check that finds the condition false, and records no event", async () => {
    seed("a", { armed: false, lastTriggeredAt: at("2026-09-20T06:10:00Z"), lastNote: "ancienne note" });
    const summary = await runClientAlerts({ now: NOW });
    expect(summary.triggered).toBe(0);
    expect(alert("a")).toMatchObject({ armed: true, lastValue: 100, lastNote: null, lastCheckedAt: NOW });
    expect(alert("a").lastTriggeredAt).toEqual(at("2026-09-20T06:10:00Z"));
    expect(h.events).toEqual([]);
  });

  it("stays silent while the condition stays true", async () => {
    seed("a", { armed: false, lastTriggeredAt: at("2026-09-20T06:10:00Z") });
    high("a");
    const summary = await runClientAlerts({ now: NOW });
    expect(summary.triggered).toBe(0);
    expect(h.events).toEqual([]);
    expect(alert("a")).toMatchObject({ armed: false, lastValue: 200 });
    expect(alert("a").lastTriggeredAt).toEqual(at("2026-09-20T06:10:00Z"));
  });

  it("keeps the silence after a message even when re-armed since", async () => {
    // Message yesterday morning, back to normal in the afternoon, true again today: 24 h < 72 h.
    seed("a", { armed: true, lastTriggeredAt: at("2026-09-28T06:10:00Z") });
    high("a");
    await runClientAlerts({ now: NOW });
    expect(h.events).toEqual([]);
    expect(alert("a").armed).toBe(true);
    // Three days after the message, it goes.
    await runClientAlerts({ now: at("2026-10-01T06:10:00Z") });
    expect(h.events).toHaveLength(1);
  });

  it("reminds after the cooldown only when the alert asks for it", async () => {
    seed("quiet", { armed: false, lastTriggeredAt: at("2026-09-26T06:10:00Z") }, { remind: false });
    seed("remind", { armed: false, lastTriggeredAt: at("2026-09-26T06:10:00Z") }, { remind: true });
    seed("early", { armed: false, lastTriggeredAt: at("2026-09-27T06:10:00Z") }, { remind: true });
    high("quiet", "remind", "early");
    await runClientAlerts({ now: NOW });
    expect(h.events.map((e) => [e.alertId, e.kind])).toEqual([["remind", "reminder"]]);
    expect(alert("remind")).toMatchObject({ armed: false, lastTriggeredAt: NOW });
    expect(alert("early").lastTriggeredAt).toEqual(at("2026-09-27T06:10:00Z"));
  });

  it("notes why a check was skipped and leaves the state as it was", async () => {
    seed("armed");
    seed("sent", { armed: false, lastTriggeredAt: at("2026-09-20T06:10:00Z") });
    unreadable.add("act_armed");
    unreadable.add("act_sent");
    const summary = await runClientAlerts({ now: NOW });
    expect(summary).toMatchObject({ checked: 2, skipped: 2, triggered: 0 });
    expect(alert("armed")).toMatchObject({ armed: true, lastValue: null, lastCheckedAt: NOW });
    expect(alert("armed").lastNote).toMatch(/illisible.*relay 502/);
    // Not judged is not "back to normal": the alert is not re-armed.
    expect(alert("sent").armed).toBe(false);
    expect(h.events).toEqual([]);
  });

  it("reads the day in progress: a stop of spend this afternoon triggers today", async () => {
    seed("a", {}, { condition: "stopped", threshold: null });
    today.set("act_a", { spend: 0, conversions: 0, hour: 14.2 });
    const now = at("2026-09-29T12:10:00Z");
    await runClientAlerts({ now });
    expect(h.events).toHaveLength(1);
    expect((JSON.parse(h.events[0].detailJson as string) as Evaluation).asOf).toBe("2026-09-29");
    expect(h.events[0].threshold).toBeNull();
  });

  it("goes on with the other alerts when one fails, and reports it", async () => {
    seed("bad"); seed("good");
    high("good");
    const read = h.read.getMockImplementation()!;
    h.read.mockImplementation(async (accounts: AlertAccountRef[], opts: unknown) => {
      if (accounts[0].accountId === "act_bad") throw new Error("relay en panne");
      return read(accounts, opts);
    });
    const summary = await runClientAlerts({ now: NOW });
    expect(summary.checked).toBe(1);
    expect(summary.errors).toEqual(["Client bad — Alerte bad : relay en panne"]);
    expect(alert("bad").lastCheckedAt).toBeNull();
    expect(eventsOf("good")).toHaveLength(1);
  });

  it("does not advance the state when the message cannot be written", async () => {
    seed("a");
    high("a");
    h.line.mockImplementation(() => { throw new Error("not implemented"); });
    const summary = await runClientAlerts({ now: NOW });
    expect(summary.errors).toHaveLength(1);
    expect(alert("a")).toMatchObject({ armed: true, lastTriggeredAt: null });
    expect(h.events).toEqual([]);
  });

  it("records nothing when another pass took the message first", async () => {
    seed("a");
    high("a");
    const read = h.read.getMockImplementation()!;
    // While this pass reads the platforms, another one triggers and disarms the alert.
    h.read.mockImplementation(async (...args: unknown[]) => {
      Object.assign(alert("a"), { armed: false, lastTriggeredAt: at("2026-09-29T06:09:59Z") });
      return read(...args);
    });
    sendingOn();
    const summary = await runClientAlerts({ now: NOW });
    expect(h.events).toEqual([]);
    expect(summary.triggered).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(alert("a").lastTriggeredAt).toEqual(at("2026-09-29T06:09:59Z"));
  });
});

describe("dry run", () => {
  it("is the rule while CLIENT_ALERTS_SEND is not on: the event is recorded, the state advances, nothing is sent", async () => {
    seed("a");
    high("a");
    for (const value of [undefined, "0", "off", "yes"]) {
      h.events.length = 0;
      Object.assign(alert("a"), { armed: true, lastTriggeredAt: null });
      if (value === undefined) delete process.env.CLIENT_ALERTS_SEND; else process.env.CLIENT_ALERTS_SEND = value;
      const summary = await runClientAlerts({ now: NOW });
      expect(summary, String(value)).toMatchObject({ dryRun: true, triggered: 1, sent: 0, held: 0 });
      expect(h.events).toHaveLength(1);
      expect(h.events[0]).toMatchObject({ dryRun: true, notifiedAt: null, notifyError: null, batchId: null });
      expect(alert("a")).toMatchObject({ armed: false, lastTriggeredAt: NOW });
    }
    expect(h.send).not.toHaveBeenCalled();
    expect(h.identity).not.toHaveBeenCalled();
  });

  it("can be forced while sending is on", async () => {
    sendingOn();
    seed("a");
    high("a");
    const summary = await runClientAlerts({ now: NOW, dryRun: true });
    expect(summary).toMatchObject({ dryRun: true, triggered: 1, sent: 0 });
    expect(h.events[0]).toMatchObject({ dryRun: true, notifiedAt: null });
    expect(h.send).not.toHaveBeenCalled();
    // The same pass without the flag sends.
    Object.assign(alert("a"), { armed: true, lastTriggeredAt: null });
    const real = await runClientAlerts({ now: NOW });
    expect(real).toMatchObject({ dryRun: false, sent: 1 });
    expect(h.events[1]).toMatchObject({ dryRun: false, notifiedAt: NOW });
  });

  it("notes a general anomaly on its events as a real pass would", async () => {
    for (let i = 0; i < 6; i++) seed(`a${i}`);
    high("a0", "a1", "a2", "a3", "a4");
    const summary = await runClientAlerts({ now: NOW });
    expect(summary).toMatchObject({ dryRun: true, triggered: 5, sent: 0, held: 5 });
    for (const e of h.events) expect(e).toMatchObject({ dryRun: true, notifyError: "anomalie générale : non envoyé", notifiedAt: null });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("mirrors a real pass: the same alerts are left armed or not", async () => {
    seed("a"); seed("b");
    high("a");
    await runClientAlerts({ now: NOW });
    const dry = h.alerts.map((a) => [a.id, a.armed, a.lastTriggeredAt, a.lastValue]);
    h.events.length = 0;
    h.alerts.forEach((a) => Object.assign(a, { armed: true, lastTriggeredAt: null, lastCheckedAt: null, lastValue: null }));
    sendingOn();
    await runClientAlerts({ now: NOW });
    expect(h.alerts.map((a) => [a.id, a.armed, a.lastTriggeredAt, a.lastValue])).toEqual(dry);
  });
});

describe("sending", () => {
  beforeEach(sendingOn);

  it("sends one private message per consultant and per pass, with all of their alerts", async () => {
    process.env.NEXTAUTH_URL = "https://app.impulse.test/";
    seed("a"); seed("b"); seed("calm");
    seed("c", { createdById: "u2", createdByEmail: "tom@impulse.test" });
    // Enough quiet alerts around: four triggers out of many is not a general anomaly.
    for (let i = 0; i < 6; i++) seed(`quiet${i}`);
    high("a", "b", "c");
    const summary = await runClientAlerts({ now: NOW });
    expect(summary).toMatchObject({ dryRun: false, triggered: 3, sent: 2, held: 0, errors: [] });
    expect(h.send).toHaveBeenCalledTimes(2);
    const [first, second] = h.send.mock.calls as Array<[string, string]>;
    expect(first[0]).toBe("UU10000000");
    expect(JSON.parse(first[1])).toEqual({ lines: ["Client a [trigger]", "Client b [trigger]"], extra: 0, pageUrl: "https://app.impulse.test/admin/alerts/assistant" });
    expect(second[0]).toBe("UU20000000");
    expect(JSON.parse(second[1]).lines).toEqual(["Client c [trigger]"]);
    // The events of one message share a batch; two messages, two batches.
    const batch = (id: string) => eventsOf(id)[0].batchId as string;
    expect(batch("a")).toBeTruthy();
    expect(batch("a")).toBe(batch("b"));
    expect(batch("c")).not.toBe(batch("a"));
    for (const e of h.events) expect(e).toMatchObject({ notifiedAt: NOW, notifyError: null, dryRun: false });
  });

  it("gives no link when the address of the app is not set", async () => {
    seed("a");
    high("a");
    await runClientAlerts({ now: NOW });
    expect(JSON.parse((h.send.mock.calls[0] as [string, string])[1]).pageUrl).toBeNull();
  });

  it("writes out a few alerts and counts the others in one line", async () => {
    const ids = Array.from({ length: MAX_LINES_PER_DM + 2 }, (_, i) => `a${i}`);
    ids.forEach((id) => seed(id));
    // Twice as many quiet alerts: this is not a general anomaly.
    for (let i = 0; i < ids.length * 2; i++) seed(`quiet${i}`);
    high(...ids);
    const summary = await runClientAlerts({ now: NOW });
    expect(summary.sent).toBe(1);
    const sent = JSON.parse((h.send.mock.calls[0] as [string, string])[1]) as { lines: string[]; extra: number };
    expect(sent.lines).toHaveLength(MAX_LINES_PER_DM);
    expect(sent.extra).toBe(2);
    // Announced by their number: they are delivered too.
    expect(h.events.every((e) => e.notifiedAt !== null)).toBe(true);
  });

  it("resets the failures of an alert once a message went through", async () => {
    seed("a", { consecutiveFailures: 2 });
    high("a");
    await runClientAlerts({ now: NOW });
    expect(alert("a")).toMatchObject({ consecutiveFailures: 0, status: "active" });
  });

  describe("general anomaly", () => {
    const pass = async (triggering: number, total: number) => {
      const ids = Array.from({ length: total }, (_, i) => `a${i}`);
      ids.forEach((id) => seed(id));
      high(...ids.slice(0, triggering));
      return runClientAlerts({ now: NOW });
    };

    it("sends nothing when 5 alerts or more trigger and they are at least half of those checked", async () => {
      const summary = await pass(5, 10);
      expect(summary).toMatchObject({ checked: 10, triggered: 5, sent: 0, held: 5 });
      expect(h.send).not.toHaveBeenCalled();
      expect(h.identity).not.toHaveBeenCalled();
      expect(h.events).toHaveLength(5);
      for (const e of h.events) expect(e).toMatchObject({ notifyError: "anomalie générale : non envoyé", notifiedAt: null, batchId: null });
      expect(HELD.flood).toBe("anomalie générale : non envoyé");
      expect(summary.errors.join(" ")).toMatch(/Anomalie générale/);
      // The state advanced all the same: no avalanche at the next pass either.
      expect(h.alerts.filter((a) => a.armed === false)).toHaveLength(5);
      h.send.mockClear();
      const next = await runClientAlerts({ now: at("2026-09-29T09:10:00Z") });
      expect(next.triggered).toBe(0);
      expect(h.send).not.toHaveBeenCalled();
    });

    it("sends when they are under half of the alerts checked", async () => {
      const summary = await pass(5, 11);
      expect(summary).toMatchObject({ checked: 11, triggered: 5, sent: 1, held: 0 });
      expect(h.events.every((e) => e.notifiedAt !== null && e.notifyError === null)).toBe(true);
    });

    it("sends under 5 alerts, even when they are all of them", async () => {
      const summary = await pass(FLOOD.minAlerts - 1, FLOOD.minAlerts - 1);
      expect(summary).toMatchObject({ triggered: 4, sent: 1, held: 0 });
    });

    it("counts skipped alerts among those checked, not the alerts left for review", async () => {
      // 5 triggers, 5 others that are due: 4 checked (one of them skipped) and one sent to review.
      h.clients.push({ id: "cl1", name: "Parti", gone: true, accountsJson: "[]" });
      for (let i = 0; i < 9; i++) seed(`a${i}`);
      seed("left", { alertClientId: "cl1" });
      high("a0", "a1", "a2", "a3", "a4");
      unreadable.add("act_a8");
      const summary = await runClientAlerts({ now: NOW });
      expect(summary).toMatchObject({ checked: 9, triggered: 5, skipped: 1, sent: 0, held: 5 });
    });
  });

  describe("ceilings", () => {
    /** A message already delivered to u1, in its own batch. */
    const delivered = (batchId: string, notifiedAt: string, alertId = "old") => h.events.push({ id: `old-${h.events.length}`, alertId, kind: "trigger", notifiedAt: at(notifiedAt), notifyError: null, batchId, dryRun: false });

    it("holds back what exceeds the private messages of a consultant for the day", async () => {
      seed("old", { status: "paused" });
      seed("a"); seed("calm1"); seed("calm2");
      seed("other", { createdById: "u2" });
      high("a", "other");
      for (let i = 0; i < MAX_DM_PER_USER_PER_DAY; i++) delivered(`batch-${i}`, "2026-09-29T04:00:00Z");
      const summary = await runClientAlerts({ now: NOW });
      // u1 already had 5 messages today; u2 had none.
      expect(summary).toMatchObject({ triggered: 2, sent: 1, held: 1 });
      expect(h.send).toHaveBeenCalledTimes(1);
      expect((h.send.mock.calls[0] as [string, string])[0]).toBe("UU20000000");
      expect(eventsOf("a")[0]).toMatchObject({ notifiedAt: null, batchId: null });
      expect(eventsOf("a")[0].notifyError).toMatch(/par jour/);
      expect(eventsOf("other")[0].notifiedAt).toEqual(NOW);
    });

    it("counts messages, not alerts: several events of one batch are one message", async () => {
      seed("old", { status: "paused" });
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      // 6 events delivered today in 4 messages.
      for (let i = 0; i < 6; i++) delivered(`batch-${Math.min(i, 3)}`, "2026-09-29T04:00:00Z");
      expect((await runClientAlerts({ now: NOW })).sent).toBe(1);
    });

    it("counts the day in Paris", async () => {
      seed("old", { status: "paused" });
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      // Four messages yesterday evening (23:00 in Paris), one after midnight in Paris (22:30 UTC the day before).
      for (let i = 0; i < 4; i++) delivered(`batch-${i}`, "2026-09-28T21:00:00Z");
      delivered("batch-late", "2026-09-28T22:30:00Z");
      expect((await runClientAlerts({ now: NOW })).sent).toBe(1);
      // Five after midnight in Paris: the day is full.
      Object.assign(alert("a"), { armed: true, lastTriggeredAt: null });
      for (let i = 0; i < 4; i++) delivered(`batch-night-${i}`, "2026-09-28T22:45:00Z");
      h.send.mockClear();
      const full = await runClientAlerts({ now: at("2026-09-29T09:10:00Z") });
      expect(full).toMatchObject({ sent: 0, held: 1 });
      expect(h.send).not.toHaveBeenCalled();
    });

    it("does not count the messages of another consultant", async () => {
      seed("old", { status: "paused", createdById: "u2" });
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      for (let i = 0; i < MAX_DM_PER_USER_PER_DAY; i++) delivered(`batch-${i}`, "2026-09-29T04:00:00Z");
      expect((await runClientAlerts({ now: NOW })).sent).toBe(1);
    });

    it("sends at most 10 private messages per pass, all consultants together", async () => {
      const users = Array.from({ length: MAX_DM_PER_RUN + 1 }, (_, i) => `u${i + 1}`);
      users.forEach((u) => seed(`alert-${u}`, { createdById: u }));
      high(...users.map((u) => `alert-${u}`));
      // 11 triggers among 23 alerts: under half.
      for (let i = 0; i < 12; i++) seed(`quiet${i}`);
      const summary = await runClientAlerts({ now: NOW });
      expect(summary).toMatchObject({ triggered: 11, sent: MAX_DM_PER_RUN, held: 1 });
      expect(h.send).toHaveBeenCalledTimes(MAX_DM_PER_RUN);
      const held = h.events.filter((e) => e.notifiedAt === null);
      expect(held).toHaveLength(1);
      expect(held[0].alertId).toBe("alert-u11");
      expect(held[0].notifyError).toMatch(/par passage/);
    });
  });

  it("keeps the events of a consultant Slack does not know, and sends nothing", async () => {
    seed("a", { consecutiveFailures: 1 }); seed("calm1"); seed("calm2");
    high("a");
    h.identity.mockResolvedValue({ email: "lea@impulse.test", slackUserId: null, checkedAt: NOW.toISOString(), status: "unknown" });
    const summary = await runClientAlerts({ now: NOW });
    expect(h.identity).toHaveBeenCalledWith("u1");
    expect(summary).toMatchObject({ triggered: 1, sent: 0, held: 1 });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.events[0]).toMatchObject({ notifyError: "adresse Slack introuvable", notifiedAt: null, batchId: null });
    // Not a failure of delivery: the alert is not on its way to `error`.
    expect(alert("a")).toMatchObject({ consecutiveFailures: 1, status: "active" });
    // Never looked up neither: nothing is sent to an id that was not confirmed.
    h.events.length = 0;
    Object.assign(alert("a"), { armed: true, lastTriggeredAt: null });
    h.identity.mockResolvedValue({ email: "lea@impulse.test", slackUserId: "U0123456789", checkedAt: null, status: "unchecked" });
    await runClientAlerts({ now: NOW });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.events[0].notifyError).toBe("adresse Slack introuvable");
  });

  it("holds everything back when the private messages are not configured, without counting a failure", async () => {
    seed("a"); seed("calm1"); seed("calm2");
    high("a");
    h.configured.mockReturnValue(false);
    const summary = await runClientAlerts({ now: NOW });
    expect(summary).toMatchObject({ sent: 0, held: 1 });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.events[0].notifyError).toMatch(/non configuré/);
    expect(alert("a").consecutiveFailures).toBe(0);
  });

  describe("a delivery that fails", () => {
    const DOWN = () => new h.SlackDmError("le service d'envoi vers Slack ne répond pas", "n8n ne répond pas");

    it("notes the error on the events and counts one failure per alert", async () => {
      seed("a"); seed("b"); seed("calm1"); seed("calm2"); seed("calm3");
      high("a", "b");
      h.send.mockRejectedValue(DOWN());
      const summary = await runClientAlerts({ now: NOW });
      expect(summary).toMatchObject({ triggered: 2, sent: 0, failed: 2, held: 0 });
      // The cron's answer carries the technical cause; the page, the words a consultant reads.
      expect(summary.errors.join(" ")).toMatch(/lea@impulse\.test.*n8n ne répond pas/);
      for (const id of ["a", "b"]) {
        expect(eventsOf(id)[0]).toMatchObject({ notifyError: "le service d'envoi vers Slack ne répond pas", notifiedAt: null, batchId: null });
        expect(alert(id)).toMatchObject({ consecutiveFailures: 1, status: "active" });
      }
      expect(alert("calm1").consecutiveFailures).toBe(0);
    });

    it("puts the alert back as it was before the trigger: the failure does not swallow it", async () => {
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      h.send.mockRejectedValueOnce(DOWN());
      await runClientAlerts({ now: NOW });
      // Nothing was said: not disarmed, no silence started. The event stays, with why.
      expect(alert("a")).toMatchObject({ armed: true, lastTriggeredAt: null, lastCheckedAt: NOW, consecutiveFailures: 1, status: "active" });
      expect(eventsOf("a")).toHaveLength(1);
      expect(eventsOf("a")[0]).toMatchObject({ notifiedAt: null, notifyError: "le service d'envoi vers Slack ne répond pas" });

      // n8n is back at the next pass, the condition is still true: the consultant is told, three hours late instead of never.
      const next = at("2026-09-29T09:10:00Z");
      const summary = await runClientAlerts({ now: next });
      expect(summary).toMatchObject({ triggered: 1, sent: 1, failed: 0 });
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(eventsOf("a")).toHaveLength(2);
      // The event that failed is never sent later; the new one is the message.
      expect(eventsOf("a")[0]).toMatchObject({ notifiedAt: null, notifyError: "le service d'envoi vers Slack ne répond pas" });
      expect(eventsOf("a")[1]).toMatchObject({ notifiedAt: next, notifyError: null });
      expect(alert("a")).toMatchObject({ armed: false, lastTriggeredAt: next, consecutiveFailures: 0 });
      // And from there, the silence: no third message.
      await runClientAlerts({ now: at("2026-09-29T12:10:00Z") });
      expect(h.send).toHaveBeenCalledTimes(2);
    });

    it("does not try again when the situation is back to normal meanwhile", async () => {
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      h.send.mockRejectedValueOnce(DOWN());
      await runClientAlerts({ now: NOW });
      lastDay.clear();
      await runClientAlerts({ now: at("2026-09-29T09:10:00Z") });
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(eventsOf("a")).toHaveLength(1);
    });

    it("puts a reminder back too: the silence of the last message delivered goes on", async () => {
      // Said four days ago, still true, reminders asked for.
      const said = at("2026-09-25T06:10:00Z");
      seed("a", { armed: false, lastTriggeredAt: said }, { remind: true }); seed("calm1"); seed("calm2");
      high("a");
      h.send.mockRejectedValueOnce(DOWN());
      await runClientAlerts({ now: NOW });
      expect(eventsOf("a")[0]).toMatchObject({ kind: "reminder", notifiedAt: null });
      expect(alert("a")).toMatchObject({ armed: false, lastTriggeredAt: said });
      await runClientAlerts({ now: at("2026-09-29T09:10:00Z") });
      expect(eventsOf("a")[1]).toMatchObject({ kind: "reminder", notifiedAt: at("2026-09-29T09:10:00Z") });
    });

    it("leaves alone a state a person changed since the trigger", async () => {
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      // While the message is on its way, the consultant validates a new rule: fresh state, another instant.
      const mine = at("2026-09-29T06:10:30Z");
      h.send.mockImplementationOnce(async () => {
        Object.assign(alert("a"), { armed: false, lastTriggeredAt: mine });
        throw DOWN();
      });
      await runClientAlerts({ now: NOW });
      expect(alert("a")).toMatchObject({ armed: false, lastTriggeredAt: mine, consecutiveFailures: 1 });
    });

    it(`switches the alert to error at ${MAX_DELIVERY_FAILURES} failures in a row`, async () => {
      seed("second", { consecutiveFailures: MAX_DELIVERY_FAILURES - 2 });
      seed("third", { consecutiveFailures: MAX_DELIVERY_FAILURES - 1 });
      for (let i = 0; i < 3; i++) seed(`calm${i}`);
      high("second", "third");
      h.send.mockRejectedValue(DOWN());
      await runClientAlerts({ now: NOW });
      expect(alert("second")).toMatchObject({ consecutiveFailures: MAX_DELIVERY_FAILURES - 1, status: "active", lastNote: null });
      expect(alert("third")).toMatchObject({ consecutiveFailures: MAX_DELIVERY_FAILURES, status: "error" });
      expect(alert("third").lastNote).toBe("Message privé Slack non remis 3 fois de suite (le service d'envoi vers Slack ne répond pas) : alerte arrêtée. Reprenez-la une fois l'envoi rétabli.");
      // An alert in error is no longer checked.
      const later = at("2026-10-03T06:10:00Z");
      await runClientAlerts({ now: later });
      expect(alert("third").lastCheckedAt).toEqual(NOW);
      expect(alert("second").lastCheckedAt).toEqual(later);
    });

    it(`ends in error after ${MAX_DELIVERY_FAILURES} passes that fail in a row, one event each`, async () => {
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      h.send.mockRejectedValue(DOWN());
      const passes = ["2026-09-29T06:10:00Z", "2026-09-29T09:10:00Z", "2026-09-29T12:10:00Z", "2026-09-29T15:10:00Z"];
      for (const iso of passes) await runClientAlerts({ now: at(iso) });
      expect(h.send).toHaveBeenCalledTimes(MAX_DELIVERY_FAILURES);
      expect(eventsOf("a")).toHaveLength(MAX_DELIVERY_FAILURES);
      expect(alert("a")).toMatchObject({ status: "error", consecutiveFailures: MAX_DELIVERY_FAILURES, armed: true, lastTriggeredAt: null });
    });

    it("treats a lookup of the Slack identity that fails as a failed delivery, and never shows the raw error", async () => {
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      h.identity.mockRejectedValue(new Error("Invalid `prisma.user.findUnique()` invocation: connection terminated"));
      const summary = await runClientAlerts({ now: NOW });
      expect(summary).toMatchObject({ sent: 0, failed: 1 });
      expect(h.events[0].notifyError).toBe("l'envoi a échoué avant d'atteindre Slack");
      expect(summary.errors.join(" ")).toMatch(/prisma\.user\.findUnique/);
      expect(alert("a")).toMatchObject({ consecutiveFailures: 1, armed: true, lastTriggeredAt: null });
    });

    it("does not stop the messages of the other consultants", async () => {
      seed("a"); seed("b", { createdById: "u2" }); seed("calm1"); seed("calm2"); seed("calm3");
      high("a", "b");
      h.send.mockRejectedValueOnce(DOWN());
      const summary = await runClientAlerts({ now: NOW });
      expect(summary.sent).toBe(1);
      expect(eventsOf("b")[0].notifiedAt).toEqual(NOW);
    });
  });

  describe("held on purpose: the state stays advanced, nothing is tried again", () => {
    const LATER = ["2026-09-29T09:10:00Z", "2026-09-29T12:10:00Z", "2026-09-30T06:10:00Z"];

    it("a person Slack does not know", async () => {
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      h.identity.mockResolvedValue({ email: "u1@impulse.test", slackUserId: null, checkedAt: NOW.toISOString(), status: "unknown" });
      const summary = await runClientAlerts({ now: NOW });
      expect(summary).toMatchObject({ held: 1, failed: 0, sent: 0 });
      expect(alert("a")).toMatchObject({ armed: false, lastTriggeredAt: NOW, consecutiveFailures: 0 });
      for (const iso of LATER) await runClientAlerts({ now: at(iso) });
      expect(eventsOf("a")).toHaveLength(1);
      expect(eventsOf("a")[0].notifyError).toBe(HELD.identity);
    });

    it("the webhook not configured, and a dry run", async () => {
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      h.configured.mockReturnValue(false);
      expect(await runClientAlerts({ now: NOW })).toMatchObject({ held: 1, failed: 0 });
      expect(alert("a")).toMatchObject({ armed: false, lastTriggeredAt: NOW });
      seed("dry"); high("dry");
      delete process.env.CLIENT_ALERTS_SEND;
      await runClientAlerts({ now: at(LATER[0]) });
      expect(alert("dry")).toMatchObject({ armed: false, lastTriggeredAt: at(LATER[0]), consecutiveFailures: 0 });
      for (const iso of LATER.slice(1)) await runClientAlerts({ now: at(iso) });
      expect(eventsOf("a")).toHaveLength(1);
      expect(eventsOf("dry")).toHaveLength(1);
    });

    it("the flood guard and the ceilings", async () => {
      // Five alerts out of five trigger at once: an outage, nothing is sent — and nothing is sent later either.
      for (let i = 0; i < FLOOD.minAlerts; i++) { seed(`f${i}`); high(`f${i}`); }
      const summary = await runClientAlerts({ now: NOW });
      expect(summary).toMatchObject({ held: FLOOD.minAlerts, failed: 0, sent: 0 });
      for (let i = 0; i < FLOOD.minAlerts; i++) expect(alert(`f${i}`)).toMatchObject({ armed: false, lastTriggeredAt: NOW, consecutiveFailures: 0 });
      for (const iso of LATER) await runClientAlerts({ now: at(iso) });
      expect(h.send).not.toHaveBeenCalled();
      expect(h.events).toHaveLength(FLOOD.minAlerts);
    });
  });

  describe("never twice", () => {
    it("sends one message for a condition that stays true pass after pass", async () => {
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      for (const iso of ["2026-09-29T06:10:00Z", "2026-09-29T09:10:00Z", "2026-09-29T12:10:00Z", "2026-09-29T15:10:00Z", "2026-09-30T06:10:00Z", "2026-10-02T06:10:00Z", "2026-10-05T06:10:00Z"]) {
        await runClientAlerts({ now: at(iso) });
      }
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.events).toHaveLength(1);
    });

    it("does not send again the same pass run twice", async () => {
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      await runClientAlerts({ now: NOW });
      await runClientAlerts({ now: NOW });
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.events).toHaveLength(1);
    });

    it("never sends later the EVENT whose delivery failed — the alert tries again with a new one", async () => {
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      h.send.mockRejectedValueOnce(new h.SlackDmError("le service d'envoi vers Slack ne répond pas", "n8n ne répond pas"));
      await runClientAlerts({ now: NOW });
      expect(h.events[0].notifiedAt).toBeNull();
      // Slack is back, the condition is still true: one message, for the event of that pass, and then the silence.
      for (const iso of ["2026-09-29T09:10:00Z", "2026-09-30T06:10:00Z", "2026-10-01T06:10:00Z"]) await runClientAlerts({ now: at(iso) });
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.events).toHaveLength(2);
      expect(h.events[0].notifiedAt).toBeNull();
      expect(h.events[1].notifiedAt).toEqual(at("2026-09-29T09:10:00Z"));
    });

    it("does not send an event that was delivered meanwhile", async () => {
      seed("a"); seed("calm1"); seed("calm2");
      high("a");
      // Between the record of the event and its delivery, another pass delivers it.
      h.configured.mockImplementation(() => {
        h.events.forEach((e) => Object.assign(e, { notifiedAt: at("2026-09-29T06:10:01Z"), batchId: "other-pass" }));
        return true;
      });
      const summary = await runClientAlerts({ now: NOW });
      expect(h.send).not.toHaveBeenCalled();
      expect(summary.sent).toBe(0);
      expect(h.events[0]).toMatchObject({ batchId: "other-pass", notifiedAt: at("2026-09-29T06:10:01Z") });
    });
  });
});

describe("cron route", () => {
  const call = (query = "", headers: Record<string, string> = { authorization: "Bearer s3cret" }, method: "GET" | "POST" = "GET") =>
    route[method](new NextRequest(`https://app.impulse.test/api/cron/client-alerts${query}`, { method, headers }));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-09-29T09:10:00Z"));
    process.env.CRON_SECRET = "s3cret";
    seed("four", {}, { checks: "4x" });
    seed("once", { lastCheckedAt: at("2026-09-29T06:10:00Z") }, { checks: "1x" });
    high("four");
  });

  it("refuses a call without the secret, with a wrong one, and when no secret is set", async () => {
    expect((await call("", {})).status).toBe(401);
    expect((await call("", { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await call("", { authorization: "s3cret" })).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await call("", { authorization: "Bearer undefined" })).status).toBe(401);
    expect((await call("", { authorization: "Bearer " })).status).toBe(401);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.alerts.every((a) => a.id === "once" || a.lastCheckedAt === null)).toBe(true);
  });

  it("runs the alerts of the slot of the hour and returns the summary", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slot: 1, checked: 1, triggered: 1, skipped: 0, sent: 0, dryRun: true, held: 0, failed: 0, errors: [] });
    expect(alert("four").lastCheckedAt).toEqual(at("2026-09-29T09:10:00Z"));
    expect(alert("once").lastCheckedAt).toEqual(at("2026-09-29T06:10:00Z"));
  });

  it("answers a POST like a GET", async () => {
    expect((await call("", {}, "POST")).status).toBe(401);
    const res = await call("", { authorization: "Bearer s3cret" }, "POST");
    expect((await res.json()).checked).toBe(1);
  });

  it("forces a slot, or every active alert", async () => {
    expect(await (await call("?slot=0")).json()).toMatchObject({ slot: 0, checked: 2 });
    h.alerts.forEach((a) => Object.assign(a, { lastCheckedAt: at("2026-09-29T09:10:00Z") }));
    expect(await (await call("?slot=3")).json()).toMatchObject({ slot: 3, checked: 1 });
    expect(await (await call("?all=1")).json()).toMatchObject({ slot: null, checked: 2 });
    // Anything that is not a slot is ignored: the slot of the hour.
    expect(await (await call("?slot=7")).json()).toMatchObject({ slot: 1, checked: 1 });
  });

  it("forces a dry run while sending is on", async () => {
    sendingOn();
    expect(await (await call("?dry=1")).json()).toMatchObject({ dryRun: true, triggered: 1, sent: 0 });
    expect(h.send).not.toHaveBeenCalled();
    Object.assign(alert("four"), { armed: true, lastTriggeredAt: null });
    expect(await (await call()).json()).toMatchObject({ dryRun: false, triggered: 1, sent: 1 });
  });

  it("does nothing at all when the emergency stop is on, but still asks for the secret", async () => {
    process.env.CLIENT_ALERTS_CRON = " OFF ";
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });
    expect(h.read).not.toHaveBeenCalled();
    expect(alert("four").lastCheckedAt).toBeNull();
    expect(h.events).toEqual([]);
    expect((await call("", {})).status).toBe(401);
  });
});

function same(a: unknown, b: Date): boolean {
  return a instanceof Date && a.getTime() === b.getTime();
}
