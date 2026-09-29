import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type Session = { userId: string; role: string; baseRole: string; user: { email: string } };
let session: Session | null = null;
const deny = (status: number, error: string) => ({ error: NextResponse.json({ error }, { status }) });

vi.mock("@/lib/auth-helpers", () => ({
  requireStaff: async () => {
    if (!session) return deny(401, "unauthorized");
    return session.role === "admin" || session.role === "consultant" ? { session } : deny(403, "forbidden");
  },
  requireRealAdmin: async () => {
    if (!session) return deny(401, "unauthorized");
    return session.baseRole === "admin" ? { session } : deny(403, "forbidden");
  },
}));
vi.mock("@/lib/prisma", async () => ({ prisma: (await import("./routines-engine-fakes")).db }));
vi.mock("@/lib/routines/steps/sheet-read", async () => ({ sheetReadHandler: (await import("./routines-engine-fakes")).fakeHandler("sheet.read") }));
vi.mock("@/lib/routines/steps/sheet-write", async () => ({ sheetWriteHandler: (await import("./routines-engine-fakes")).fakeHandler("sheet.write") }));
vi.mock("@/lib/routines/steps/google-insights", async () => ({ googleInsightsHandler: (await import("./routines-engine-fakes")).fakeHandler("google.insights") }));
vi.mock("@/lib/routines/steps/slack-message", async () => ({ slackMessageHandler: (await import("./routines-engine-fakes")).fakeHandler("slack.message") }));
vi.mock("@/lib/routines/steps/email-send", async () => ({ emailSendHandler: (await import("./routines-engine-fakes")).fakeHandler("email.send") }));
vi.mock("@/lib/routines/steps/meta-insights", async () => ({ metaInsightsHandler: (await import("./routines-engine-fakes")).fakeHandler("meta.insights") }));
vi.mock("@/lib/routines/steps/meta-create-ads", async () => ({ metaCreateAdsHandler: (await import("./routines-engine-fakes")).fakeHandler("meta.create_ads") }));
vi.mock("@/lib/routines/steps/ai-summary", async () => ({ aiSummaryHandler: (await import("./routines-engine-fakes")).fakeHandler("ai.summary") }));

import * as listRoute from "@/app/api/routines/route";
import * as oneRoute from "@/app/api/routines/[id]/route";
import * as definitionRoute from "@/app/api/routines/[id]/definition/route";
import * as dryRunRoute from "@/app/api/routines/[id]/dry-run/route";
import * as activateRoute from "@/app/api/routines/[id]/activate/route";
import * as runRoute from "@/app/api/routines/[id]/run/route";
import * as runsRoute from "@/app/api/routines/[id]/runs/route";
import * as cronRoute from "@/app/api/cron/routines/route";
import { hashDefinition } from "@/lib/routines/hash";
import { behaviours, createAdsStep, db, okOutcome, preflights, readStep, resetDb, resetSteps, seen, slackStep } from "./routines-engine-fakes";

/** A route handler always answers; the type of the guards makes the compiler doubt it. */
const sure = <A extends unknown[]>(handler: (...args: A) => Promise<Response | undefined>) => async (...args: A): Promise<Response> => (await handler(...args))!;
const LIST = sure(listRoute.GET), CREATE = sure(listRoute.POST);
const GET = sure(oneRoute.GET), PATCH = sure(oneRoute.PATCH), DELETE = sure(oneRoute.DELETE);
const DEFINE = sure(definitionRoute.POST), DRY_RUN = sure(dryRunRoute.POST), ACTIVATE = sure(activateRoute.POST);
const RUN = sure(runRoute.POST), RUNS = sure(runsRoute.GET);
const CRON = sure(cronRoute.GET), CRON_POST = sure(cronRoute.POST);

const CONSULTANT: Session = { userId: "u-consultant", role: "admin", baseRole: "consultant", user: { email: "lea@impulse.test" } };
const ADMIN: Session = { userId: "u-admin", role: "admin", baseRole: "admin", user: { email: "chef@impulse.test" } };
/** What a consultant would be if CONSULTANT_FULL_ACCESS were switched off: scoped to assigned accounts. */
const SCOPED: Session = { userId: "u-scoped", role: "consultant", baseRole: "consultant", user: { email: "sam@impulse.test" } };
const CLIENT: Session = { userId: "u-client", role: "client", baseRole: "client", user: { email: "client@lpev.test" } };

const at = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body?: unknown, url = "http://x/api/routines", headers: Record<string, string> = {}) =>
  new NextRequest(url, body === undefined ? { method: "POST", headers } : { method: "POST", body: JSON.stringify(body), headers });

const proposal = (steps: unknown[] = [readStep, slackStep], extra: Record<string, unknown> = {}) => ({
  name: "Bilan du lundi", description: "Lit le Sheet et prévient le canal.", schedule: { kind: "weekly", time: "09:00", weekdays: [1] },
  definition: { version: 1, steps }, explanation: "…", assumptions: [], ...extra,
});

async function draft(body: Record<string, unknown> = {}): Promise<string> {
  const res = await CREATE(req({ name: "Bilan du lundi", metaAccountId: "act_123", ...body }));
  expect(res.status).toBe(201);
  return (await res.json()).routine.id;
}
/** Draft → definition applied → dry run → active. */
async function active(steps: unknown[] = [readStep, slackStep], extra: Record<string, unknown> = {}): Promise<string> {
  const id = await draft();
  expect((await DEFINE(req(proposal(steps, extra)), at(id))).status).toBe(200);
  expect((await DRY_RUN(req(), at(id))).status).toBe(200);
  expect((await ACTIVATE(req(), at(id))).status).toBe(200);
  return id;
}
const row = (id: string) => db.routine.rows.find((r) => r.id === id)!;
const events = (id: string) => db.routineEvent.rows.filter((e) => e.routineId === id).map((e) => e.kind);

beforeEach(async () => {
  resetDb();
  resetSteps();
  session = CONSULTANT;
  for (const s of [CONSULTANT, ADMIN, SCOPED]) await db.user.create({ data: { id: s.userId, role: s.baseRole } });
  await db.userAdAccount.create({ data: { userId: SCOPED.userId, platform: "meta", accountId: "act_123" } });
  vi.stubEnv("ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN", "");
  vi.stubEnv("CRON_SECRET", "s3cret");
});
afterEach(() => vi.unstubAllEnvs());

describe("routines API — access", () => {
  it("is closed to visitors and to clients, on every route", async () => {
    const id = await draft();
    const calls: Array<() => Promise<Response>> = [
      () => LIST(new NextRequest("http://x/api/routines")), () => CREATE(req({ name: "x" })),
      () => GET(new NextRequest("http://x"), at(id)), () => PATCH(req({ name: "y" }), at(id)), () => DELETE(new NextRequest("http://x"), at(id)),
      () => DEFINE(req(proposal()), at(id)), () => DRY_RUN(req(), at(id)), () => ACTIVATE(req(), at(id)), () => RUN(req(), at(id)),
      () => RUNS(new NextRequest("http://x"), at(id)),
    ];
    for (const [who, status] of [[null, 401], [CLIENT, 403]] as const) {
      session = who;
      for (const call of calls) expect((await call()).status).toBe(status);
    }
    expect(row(id)).toMatchObject({ name: "Bilan du lundi", status: "draft" });
    expect(db.routineRun.rows).toEqual([]);
  });

  it("checks the accounts received against the scope of the person", async () => {
    session = SCOPED;
    expect((await CREATE(req({ name: "Mienne", metaAccountId: "act_123" }))).status).toBe(201);
    expect((await CREATE(req({ name: "Mienne", metaAccountId: "123" }))).status).toBe(201);
    const other = await CREATE(req({ name: "Pas la mienne", metaAccountId: "act_999" }));
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ error: "forbidden", account: "act_999" });
    expect((await CREATE(req({ name: "Pas la mienne", metaAccountId: "act_123", googleCustomerId: "1234567890" }))).status).toBe(403);
    expect(db.routine.rows).toHaveLength(2);
  });

  it("takes the accounts of a dashboard, if the dashboard is in scope", async () => {
    const mine = await db.dashboard.create({ data: { name: "LPEV", metaAccountId: "act_123", googleCustomerId: null } });
    const theirs = await db.dashboard.create({ data: { name: "ICN", metaAccountId: "act_999", googleCustomerId: "1112223334" } });
    session = SCOPED;
    const ok = await CREATE(req({ name: "Depuis le dashboard", dashboardId: mine.id }));
    expect(ok.status).toBe(201);
    expect((await ok.json()).routine).toMatchObject({ dashboardId: mine.id, clientName: "LPEV", metaAccountId: "act_123", status: "draft" });
    expect((await CREATE(req({ name: "x", dashboardId: theirs.id }))).status).toBe(403);
    expect((await CREATE(req({ name: "x", dashboardId: "inconnu" }))).status).toBe(404);
    // A dashboard in scope does not open another account.
    expect((await CREATE(req({ name: "x", dashboardId: mine.id, metaAccountId: "act_999" }))).status).toBe(403);
    expect(db.routine.rows).toHaveLength(1);
  });

  it("hides the routines of accounts out of scope", async () => {
    session = ADMIN;
    const mine = await draft({ metaAccountId: "act_123" });
    const theirs = await draft({ metaAccountId: "act_999" });
    session = SCOPED;
    expect((await (await LIST(new NextRequest("http://x/api/routines"))).json()).routines.map((r: { id: string }) => r.id)).toEqual([mine]);
    expect((await GET(new NextRequest("http://x"), at(mine))).status).toBe(200);
    for (const call of [
      () => GET(new NextRequest("http://x"), at(theirs)), () => PATCH(req({ name: "volée" }), at(theirs)), () => DELETE(new NextRequest("http://x"), at(theirs)),
      () => DEFINE(req(proposal()), at(theirs)), () => DRY_RUN(req(), at(theirs)), () => ACTIVATE(req(), at(theirs)), () => RUN(req(), at(theirs)),
      () => RUNS(new NextRequest("http://x"), at(theirs)),
    ]) expect((await call()).status).toBe(403);
    expect(row(theirs)).toMatchObject({ name: "Bilan du lundi", status: "draft" });
    expect((await GET(new NextRequest("http://x"), at("inconnue123"))).status).toBe(404);
    expect((await GET(new NextRequest("http://x"), at("../etc"))).status).toBe(404);
  });
});

describe("routines API — draft", () => {
  it("creates a draft and logs who did", async () => {
    const res = await CREATE(req({ name: "  Créas   LPEV ", clientName: "LPEV", metaAccountId: "act_123", googleCustomerId: "123-456-7890" }));
    const { routine } = await res.json();
    expect(routine).toMatchObject({
      name: "Créas LPEV", status: "draft", clientName: "LPEV", metaAccountId: "act_123", googleCustomerId: "123-456-7890",
      createdById: CONSULTANT.userId, createdByEmail: "lea@impulse.test", timezone: "Europe/Paris", maxItemsPerRun: 20,
      nextRunAt: null, dryRunValid: false, running: false, writesPlatform: false,
    });
    expect(routine).not.toHaveProperty("chatJson");
    expect(db.routineEvent.rows).toMatchObject([{ kind: "created", userId: CONSULTANT.userId, userEmail: "lea@impulse.test", userRole: "consultant" }]);
  });

  it("refuses a bad name or a malformed account", async () => {
    for (const body of [{}, { name: "" }, { name: 3 }, { name: "x".repeat(121) }, { name: "ok", metaAccountId: "act_12; DROP" }, { name: "ok", metaAccountId: "https://x" }, { name: "ok", googleCustomerId: "abc" }]) {
      expect((await CREATE(req(body))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await CREATE(new NextRequest("http://x", { method: "POST", body: "{pas du json" }))).status).toBe(400);
    expect(db.routine.rows).toEqual([]);
  });

  it("lists without the archived ones", async () => {
    const a = await draft({ name: "A" });
    const b = await draft({ name: "B" });
    expect((await DELETE(new NextRequest("http://x"), at(a))).status).toBe(200);
    const list = async (q = "") => (await (await LIST(new NextRequest(`http://x/api/routines${q}`))).json()).routines.map((r: { id: string }) => r.id);
    expect(await list()).toEqual([b]);
    expect((await list("?archived=1")).sort()).toEqual([a, b].sort());
    expect(row(a).status).toBe("archived");
    expect(events(a)).toEqual(["created", "archived"]);
  });
});

describe("routines API — definition", () => {
  it("stores a valid proposal and sends the routine to ready", async () => {
    const id = await draft();
    const res = await DEFINE(req({ proposal: proposal([readStep, createAdsStep], { maxItemsPerRun: 10 }) }), at(id));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, issues: [], routine: { status: "ready", name: "Bilan du lundi", maxItemsPerRun: 10, writesPlatform: true, dryRunValid: false, nextRunAt: null } });
    expect(json.routine.definition.steps.map((s: { id: string }) => s.id)).toEqual(["lire", "creer"]);
    expect(json.routine.schedule).toEqual({ kind: "weekly", time: "09:00", weekdays: [1] });
    expect(json.definitionHash).toBe(hashDefinition({ definition: json.routine.definition, schedule: json.routine.schedule, maxItemsPerRun: 10 }));
    expect(row(id).definitionHash).toBe(json.definitionHash);
    expect(events(id)).toEqual(["created", "definition_applied"]);
  });

  it("refuses a forged proposal and stores nothing of it", async () => {
    const id = await draft();
    const forged: unknown[] = [
      proposal([readStep, { id: "x", type: "meta.update_budget", budget: 900 }]),
      proposal([readStep, ...Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, type: "rows.limit", count: 1 }))]),
      proposal([readStep, createAdsStep, { ...createAdsStep, id: "encore" }]),
      proposal([readStep, { ...createAdsStep, status: "ACTIVE" }]),
      proposal([readStep, { ...slackStep, text: "{{env.CRON_SECRET}}" }]),
      proposal([readStep, slackStep], { maxItemsPerRun: 500 }),
      proposal([readStep, slackStep], { schedule: { kind: "daily", time: "09:00", cron: "* * * * *" } }),
      proposal([readStep, slackStep], { metaAccountId: "act_999" }),
      { definition: { version: 1, steps: [slackStep] } }, null, "routine", [],
    ];
    for (const body of forged) {
      const res = await DEFINE(req(body), at(id));
      expect(res.status, JSON.stringify(body)?.slice(0, 80)).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("proposition invalide");
      expect(json.errors.length).toBeGreaterThan(0);
    }
    expect(row(id)).toMatchObject({ status: "draft", definitionJson: "{}", definitionHash: "", metaAccountId: "act_123" });
    expect(events(id)).toEqual(["created"]);
  });

  it("runs the preflight of every step on the account of the routine, and blocks on an error", async () => {
    const id = await draft();
    const checked: unknown[] = [];
    preflights["sheet.read"] = async (step, routine) => { checked.push([step.id, routine.metaAccountId, routine.id]); return [{ stepId: "ailleurs", severity: "warning", message: "Onglet presque plein" }]; };
    preflights["meta.create_ads"] = async () => [{ stepId: "creer", severity: "error", message: "L'ensemble 222 n'appartient pas au compte act_123" }];

    const blocked = await DEFINE(req(proposal([readStep, createAdsStep])), at(id));
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).issues).toEqual([
      { stepId: "lire", severity: "warning", message: "Onglet presque plein" },
      { stepId: "creer", severity: "error", message: "L'ensemble 222 n'appartient pas au compte act_123" },
    ]);
    expect(checked).toEqual([["lire", "act_123", id]]);
    expect(row(id)).toMatchObject({ status: "draft", definitionHash: "" });

    // A warning does not block; a preflight that cannot look does.
    delete preflights["meta.create_ads"];
    const stored = await DEFINE(req(proposal([readStep, createAdsStep])), at(id));
    expect(stored.status).toBe(200);
    expect((await stored.json()).issues).toHaveLength(1);
    preflights["sheet.read"] = async () => { throw new Error("Relay inaccessible"); };
    const down = await DEFINE(req(proposal([readStep, slackStep])), at(id));
    expect(down.status).toBe(422);
    expect((await down.json()).issues[0]).toMatchObject({ stepId: "lire", severity: "error", message: expect.stringContaining("Relay inaccessible") });
    expect(JSON.parse(String(row(id).definitionJson)).steps.map((s: { id: string }) => s.id)).toEqual(["lire", "creer"]);
  });

  it("forgets the dry run and leaves the schedule when the definition changes", async () => {
    const id = await active();
    expect(row(id)).toMatchObject({ status: "active" });
    expect(row(id).nextRunAt).not.toBeNull();
    const res = await DEFINE(req(proposal([readStep, { ...slackStep, channel: "#autre" }])), at(id));
    expect(res.status).toBe(200);
    expect(row(id)).toMatchObject({ status: "ready", nextRunAt: null, dryRunHash: null, dryRunAt: null, activatedById: null });
  });

  it("is refused on an archived routine and during a run", async () => {
    const id = await draft();
    row(id).lockedUntil = new Date(Date.now() + 60_000);
    expect((await DEFINE(req(proposal()), at(id))).status).toBe(409);
    row(id).lockedUntil = null;
    await DELETE(new NextRequest("http://x"), at(id));
    expect((await DEFINE(req(proposal()), at(id))).status).toBe(409);
    expect(row(id).status).toBe("archived");
  });
});

describe("routines API — dry run and activation", () => {
  it("refuses to activate without a successful dry run", async () => {
    const id = await draft();
    expect((await ACTIVATE(req(), at(id))).status).toBe(409);
    expect((await DRY_RUN(req(), at(id))).status).toBe(409);
    await DEFINE(req(proposal()), at(id));
    const res = await ACTIVATE(req(), at(id));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "dry_run_required" });

    behaviours["sheet.read"] = () => ({ status: "failed", rowsIn: 0, rowsOut: 0, output: {}, planned: [], written: [], warnings: [], error: { class: "functional", message: "Onglet introuvable" } });
    const failed = await DRY_RUN(req(), at(id));
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ ok: false, result: { status: "failed", mode: "dry_run" }, routine: { dryRunValid: false } });
    expect((await ACTIVATE(req(), at(id))).status).toBe(409);
    expect(row(id)).toMatchObject({ status: "ready", dryRunHash: null, nextRunAt: null });
  });

  it("runs the dry run without a guard, remembers its hash, then activates", async () => {
    const id = await draft();
    await DEFINE(req(proposal([readStep, createAdsStep, slackStep])), at(id));
    behaviours["slack.message"] = () => okOutcome({ planned: [{ target: "slack", summary: "Message dans #client", preview: {} }] });
    const res = await DRY_RUN(req(), at(id));
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, result: { status: "success", mode: "dry_run", totals: { planned: 1, created: 0 } }, routine: { status: "ready", dryRunValid: true } });
    expect(seen.map((s) => s.ctx.write)).toEqual([null, null, null]);
    expect(db.routineItem.rows).toEqual([]);
    expect(row(id).dryRunHash).toBe(row(id).definitionHash);
    expect(db.routineRun.rows).toMatchObject([{ trigger: "dry_run", status: "success", startedById: CONSULTANT.userId }]);

    const activated = await ACTIVATE(req(), at(id));
    expect(activated.status).toBe(200);
    const { routine, nextRunAt } = await activated.json();
    expect(routine).toMatchObject({ status: "active", activatedById: CONSULTANT.userId, consecutiveFailures: 0 });
    // Weekly, Monday 09:00 in Paris: a Monday, at 07:00 or 08:00 UTC, within a week.
    const next = new Date(nextRunAt);
    expect(next.getUTCDay()).toBe(1);
    expect([7, 8]).toContain(next.getUTCHours());
    expect(nextRunAt - Date.now()).toBeGreaterThan(0);
    expect(nextRunAt - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    expect(events(id)).toEqual(["created", "definition_applied", "dry_run", "activated"]);
    expect(db.routineEvent.rows.at(-1)).toMatchObject({ userRole: "consultant", definitionHash: row(id).definitionHash });
    expect((await ACTIVATE(req(), at(id))).status).toBe(409);
  });

  it("refuses to activate when the hash changed after the dry run", async () => {
    const id = await draft();
    await DEFINE(req(proposal()), at(id));
    await DRY_RUN(req(), at(id));
    const tried = row(id).dryRunHash;

    // 1. A new definition applied after the dry run.
    await DEFINE(req(proposal([readStep, slackStep], { maxItemsPerRun: 21 })), at(id));
    expect(row(id).definitionHash).not.toBe(tried);
    expect(await (await ACTIVATE(req(), at(id))).json()).toMatchObject({ code: "dry_run_required" });

    // 2. The same, with the old dry run put back by hand: the hashes are compared, not the presence of a dry run.
    row(id).dryRunHash = tried;
    const outdated = await ACTIVATE(req(), at(id));
    expect(outdated.status).toBe(409);
    expect(await outdated.json()).toMatchObject({ code: "dry_run_outdated" });

    // 3. The stored definition edited under an unchanged hash: the hash is computed again, not read.
    await DRY_RUN(req(), at(id));
    expect(row(id).dryRunHash).toBe(row(id).definitionHash);
    row(id).definitionJson = JSON.stringify({ version: 1, steps: [readStep, { ...slackStep, channel: "#direction" }] });
    const edited = await ACTIVATE(req(), at(id));
    expect(edited.status).toBe(409);
    expect((await edited.json()).error).toMatch(/empreinte/);

    // 4. Only the schedule changed: still another hash.
    await DEFINE(req(proposal([readStep, slackStep], { maxItemsPerRun: 21 })), at(id));
    await DRY_RUN(req(), at(id));
    row(id).scheduleJson = JSON.stringify({ kind: "daily", time: "03:00" });
    expect((await ACTIVATE(req(), at(id))).status).toBe(409);
    expect(row(id)).toMatchObject({ status: "ready", nextRunAt: null, activatedAt: null });
  });

  it("asks for a real administrator when the routine writes on a platform and the rule is on", async () => {
    const id = await draft();
    await DEFINE(req(proposal([readStep, createAdsStep])), at(id));
    await DRY_RUN(req(), at(id));

    vi.stubEnv("ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN", "1");
    const refused = await ACTIVATE(req(), at(id));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "admin_required" });
    expect(row(id).status).toBe("ready");
    // The column is not what decides: the steps are.
    row(id).writesPlatform = false;
    expect((await ACTIVATE(req(), at(id))).status).toBe(403);

    session = ADMIN;
    expect((await ACTIVATE(req(), at(id))).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "active", activatedById: ADMIN.userId });
    expect(db.routineEvent.rows.at(-1)).toMatchObject({ kind: "activated", userRole: "admin" });
  });

  it("lets a consultant activate alone when the rule is off, or when nothing is written on a platform", async () => {
    const ads = await draft();
    await DEFINE(req(proposal([readStep, createAdsStep])), at(ads));
    await DRY_RUN(req(), at(ads));
    expect((await ACTIVATE(req(), at(ads))).status).toBe(200);

    vi.stubEnv("ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN", "1");
    const message = await draft();
    await DEFINE(req(proposal([readStep, slackStep])), at(message));
    await DRY_RUN(req(), at(message));
    expect((await ACTIVATE(req(), at(message))).status).toBe(200);
  });

  it("activates a manual routine without a next run", async () => {
    const id = await active([readStep, slackStep], { schedule: { kind: "manual" } });
    expect(row(id)).toMatchObject({ status: "active", nextRunAt: null });
  });
});

describe("routines API — pause, resume, rename, archive", () => {
  it("pauses and resumes an active routine", async () => {
    const id = await active();
    const paused = await PATCH(req({ action: "pause" }), at(id));
    expect((await paused.json()).routine).toMatchObject({ status: "paused", nextRunAt: null });
    expect((await RUN(req(), at(id))).status).toBe(409);
    expect((await PATCH(req({ action: "pause" }), at(id))).status).toBe(409);

    const resumed = await PATCH(req({ action: "resume", name: "Bilan hebdomadaire" }), at(id));
    const { routine } = await resumed.json();
    expect(routine).toMatchObject({ status: "active", name: "Bilan hebdomadaire" });
    expect(routine.nextRunAt).toBeGreaterThan(Date.now());
    expect(events(id).slice(-2)).toEqual(["paused", "resumed"]);
  });

  it("does not resume a routine that was switched off, nor one whose definition changed", async () => {
    const id = await active();
    Object.assign(row(id), { status: "error", dryRunHash: null, nextRunAt: null, consecutiveFailures: 3 });
    const res = await PATCH(req({ action: "resume" }), at(id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/essai à blanc/);
    // The way back: a new dry run, then an activation.
    expect((await ACTIVATE(req(), at(id))).status).toBe(409);
    await DRY_RUN(req(), at(id));
    expect((await ACTIVATE(req(), at(id))).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "active", consecutiveFailures: 0 });

    await PATCH(req({ action: "pause" }), at(id));
    row(id).dryRunHash = "autre";
    expect((await PATCH(req({ action: "resume" }), at(id))).status).toBe(409);
    expect(row(id).status).toBe("paused");
  });

  it("refuses unknown actions and fields that are not its own", async () => {
    const id = await active();
    expect((await PATCH(req({ action: "activate" }), at(id))).status).toBe(400);
    expect((await PATCH(req({ status: "active", metaAccountId: "act_999", maxItemsPerRun: 500 }), at(id))).status).toBe(400);
    expect((await PATCH(req({ name: "" }), at(id))).status).toBe(400);
    expect((await PATCH(req({ name: "Renommée", status: "archived", metaAccountId: "act_999" }), at(id))).status).toBe(200);
    expect(row(id)).toMatchObject({ name: "Renommée", status: "active", metaAccountId: "act_123", maxItemsPerRun: 20 });
  });

  it("archives for good", async () => {
    const id = await active();
    expect((await PATCH(req({ action: "archive" }), at(id))).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "archived", nextRunAt: null });
    for (const call of [() => PATCH(req({ action: "resume" }), at(id)), () => PATCH(req({ name: "x" }), at(id)), () => ACTIVATE(req(), at(id)), () => RUN(req(), at(id)), () => DRY_RUN(req(), at(id))]) {
      expect((await call()).status).toBe(409);
    }
    expect((await DELETE(new NextRequest("http://x"), at(id))).status).toBe(200);
    expect(events(id).filter((k) => k === "archived")).toHaveLength(1);
    expect(db.routine.rows).toHaveLength(1);
  });
});

describe("routines API — run now and history", () => {
  it("runs an active routine once, live", async () => {
    const id = await active();
    seen.length = 0;
    const due = row(id).nextRunAt;
    behaviours["slack.message"] = () => okOutcome({ written: [{ summary: "Message envoyé" }] });
    const res = await RUN(req(), at(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, result: { mode: "live", status: "success", totals: { created: 1 } }, routine: { lastRunStatus: "success", running: false } });
    expect(seen.every((s) => s.ctx.write !== null && s.ctx.mode === "live")).toBe(true);
    expect(row(id)).toMatchObject({ lockedUntil: null, nextRunAt: due });
    expect(events(id).at(-1)).toBe("run_manual");
  });

  it("refuses a routine that is not active", async () => {
    const id = await draft();
    expect((await RUN(req(), at(id))).status).toBe(409);
    await DEFINE(req(proposal()), at(id));
    await DRY_RUN(req(), at(id));
    expect((await RUN(req(), at(id))).status).toBe(409);
    expect(db.routineRun.rows.filter((r) => r.trigger !== "dry_run")).toEqual([]);
  });

  it("has one winner when two people click at the same time", async () => {
    const id = await active();
    const responses = await Promise.all([RUN(req(), at(id)), RUN(req(), at(id)), RUN(req(), at(id))]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(db.routineRun.rows.filter((r) => r.trigger === "manual")).toHaveLength(1);
    expect(events(id).filter((k) => k === "run_manual")).toHaveLength(1);
  });

  it("pages the history, most recent first", async () => {
    const id = await draft();
    for (let i = 0; i < 45; i++) {
      await db.routineRun.create({ data: { routineId: id, trigger: "schedule", status: "success", definitionHash: "h", startedAt: new Date(2026, 0, 1 + i), stepsJson: i === 44 ? "pas du json" : "[]" } });
    }
    await db.routineRun.create({ data: { routineId: "autre", trigger: "schedule", status: "success", definitionHash: "h" } });
    const page = async (q: string) => (await RUNS(new NextRequest(`http://x/api/routines/${id}/runs${q}`), at(id))).json();

    const first = await page("");
    expect(first).toMatchObject({ total: 45, page: 1, pageSize: 20, pages: 3 });
    expect(first.runs).toHaveLength(20);
    expect(first.runs[0].startedAt).toBe(new Date(2026, 0, 45).getTime());
    expect(first.runs[0].steps).toEqual([]);
    expect(first.runs[0]).toMatchObject({ trigger: "schedule", status: "success", totals: { planned: 0, created: 0, skipped: 0, failed: 0 } });
    expect((await page("?page=3")).runs).toHaveLength(5);
    expect((await page("?page=9")).runs).toEqual([]);
    expect((await page("?pageSize=500")).pageSize).toBe(50);
    expect(await page("?page=-1&pageSize=abc")).toMatchObject({ page: 1, pageSize: 20 });
  });
});

describe("routines cron", () => {
  const cron = (secret?: string) => CRON(new NextRequest("http://x/api/cron/routines", secret ? { headers: { authorization: `Bearer ${secret}` } } : {}));

  it("is closed without the secret, and when no secret is configured", async () => {
    const id = await active();
    row(id).nextRunAt = new Date(Date.now() - 60_000);
    expect((await cron()).status).toBe(401);
    expect((await cron("mauvais")).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await cron("")).status).toBe(401);
    expect((await cron("undefined")).status).toBe(401);
    expect(db.routineRun.rows.filter((r) => r.trigger === "schedule")).toEqual([]);
  });

  it("runs what is due, and only that", async () => {
    const due = await active();
    const later = await active();
    const paused = await active();
    const manual = await active([readStep, slackStep], { schedule: { kind: "manual" } });
    row(due).nextRunAt = new Date(Date.now() - 60_000);
    Object.assign(row(paused), { status: "paused", nextRunAt: new Date(Date.now() - 60_000) });
    seen.length = 0;

    const res = await cron("s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ due: 1, ran: 1, missed: 0, deferred: 0, timedOut: false, runs: [{ routineId: due, outcome: "ran", status: "success" }] });
    expect(db.routineRun.rows.filter((r) => r.trigger === "schedule")).toMatchObject([{ routineId: due, status: "success", startedById: null }]);
    expect(seen.map((s) => s.ctx.routine.id)).toEqual([due, due]);
    expect(row(due).lockedUntil).toBeNull();
    expect((row(due).nextRunAt as Date).getTime()).toBeGreaterThan(Date.now());
    for (const id of [later, paused, manual]) expect(row(id).lastRunAt).toBeNull();
    expect((await (await cron("s3cret")).json()).due).toBe(0);
  });

  it("makes one run of two firings at the same instant", async () => {
    const a = await active();
    const b = await active();
    for (const id of [a, b]) row(id).nextRunAt = new Date(Date.now() - 60_000);
    const [one, two] = await Promise.all([cron("s3cret"), CRON_POST(new NextRequest("http://x", { method: "POST", headers: { authorization: "Bearer s3cret" } }))]);
    const ran = (await one.json()).ran + (await two.json()).ran;
    expect(ran).toBe(2);
    const scheduled = db.routineRun.rows.filter((r) => r.trigger === "schedule");
    expect(scheduled.map((r) => r.routineId).sort()).toEqual([a, b].sort());
  });

  it("goes on with the others when one routine cannot be run", async () => {
    const broken = await active();
    const fine = await active();
    row(broken).nextRunAt = new Date(Date.now() - 120_000);
    row(fine).nextRunAt = new Date(Date.now() - 60_000);
    row(broken).definitionJson = "{pas du json";
    const json = await (await cron("s3cret")).json();
    expect(json.runs).toMatchObject([{ routineId: broken, outcome: "ran", status: "failed" }, { routineId: fine, outcome: "ran", status: "success" }]);
    expect(row(broken)).toMatchObject({ consecutiveFailures: 1, status: "active", lockedUntil: null });
  });

  it("records a routine late by more than 12 hours as missed", async () => {
    const id = await active();
    row(id).nextRunAt = new Date(Date.now() - 13 * 3_600_000);
    seen.length = 0;
    expect(await (await cron("s3cret")).json()).toMatchObject({ due: 1, ran: 0, missed: 1 });
    expect(seen).toEqual([]);
    expect(db.routineRun.rows.at(-1)).toMatchObject({ status: "missed" });
    expect((row(id).nextRunAt as Date).getTime()).toBeGreaterThan(Date.now());
  });
});
