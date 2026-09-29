/**
 * Routines — hardening, second part: the REAL routes and the REAL engine, the
 * step handlers replaced (routines-engine-fakes.ts) so that a case decides
 * what a step does: answer after the end of the run, never answer.
 *
 * Same rule as routines-hardening.test.ts: every case fails on the commit the
 * review was made on (aabfd71) and passes now; what did not exist then is
 * imported inside the case that needs it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type Session = { userId: string; role: string; baseRole: string; user: { email: string } };
let session: Session | null = null;
const deny = (status: number, error: string) => ({ error: NextResponse.json({ error }, { status }) });

vi.mock("@/lib/auth-helpers", () => ({
  requireStaff: async () => (!session ? deny(401, "unauthorized") : session.role === "admin" || session.role === "consultant" ? { session } : deny(403, "forbidden")),
  requireRealAdmin: async () => (!session ? deny(401, "unauthorized") : session.baseRole === "admin" ? { session } : deny(403, "forbidden")),
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
import * as assistantRoute from "@/app/api/routines/[id]/assistant/route";
import { runLocked, runRoutine } from "@/lib/routines/engine";
import { sendSlackMessage } from "@/lib/routines/notify";
import { appendRows } from "@/lib/relay-sheets";
import { getRoutine } from "@/lib/routines/store";
import type { StepContext, WriteGuard } from "@/lib/routines/types";
import { behaviours, db, okOutcome, resetDb, resetSteps, seen } from "./routines-engine-fakes";

const sure = <A extends unknown[]>(h: (...a: A) => Promise<Response | undefined>) => async (...a: A): Promise<Response> => (await h(...a))!;
const CREATE = sure(listRoute.POST), PATCH = sure(oneRoute.PATCH);
const DEFINE = sure(definitionRoute.POST), DRY_RUN = sure(dryRunRoute.POST), ACTIVATE = sure(activateRoute.POST), RUN = sure(runRoute.POST);
const CHAT_GET = sure(assistantRoute.GET), CHAT_PUT = sure(assistantRoute.PUT);

const LEA: Session = { userId: "u-lea", role: "admin", baseRole: "consultant", user: { email: "lea@impulse.test" } };
const SAM: Session = { userId: "u-sam", role: "admin", baseRole: "consultant", user: { email: "sam@impulse.test" } };
const CHEF: Session = { userId: "u-admin", role: "admin", baseRole: "admin", user: { email: "chef@impulse.test" } };

const ACCOUNT = "act_564381881705822";
const PAGE = "103591049029300";
const N8N = "https://n8n.example.org/webhook/impulsemotion-auto-alerts";
const SHEET = { spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", tab: "Créas" };
const READ = { id: "lire", type: "sheet.read", sheet: SHEET, requiredColumns: ["id", "nom"] };
const ADS = {
  id: "creer", type: "meta.create_ads", campaignId: "120210000000000001", adsetId: "120210000000000002", pageId: PAGE, keyColumn: "id",
  mapping: { adName: "{{row.nom}}", primaryText: "{{row.texte}}", linkUrl: "{{row.lien}}", mediaType: "image", mediaUrl: "{{row.image}}" },
};
const SLACK = { id: "prevenir", type: "slack.message", channel: "#c_client", text: "Bilan du {{run.date}}" };

const at = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body?: unknown) => new NextRequest("http://x/api/routines", body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) });
const proposal = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  name: "Créas", description: "d", schedule: { kind: "daily", time: "09:00" }, definition: { version: 1, steps }, explanation: "e", assumptions: [], ...extra,
});
const row = (id: string) => db.routine.rows.find((r) => r.id === id)!;

/** Every call that left the application. */
const sent: Array<{ method: string; url: string; body: string }> = [];

beforeEach(async () => {
  resetDb(); resetSteps(); sent.length = 0;
  session = LEA;
  for (const s of [LEA, SAM, CHEF]) await db.user.create({ data: { id: s.userId, role: s.baseRole, email: s.user.email } });
  behaviours["sheet.read"] = () => okOutcome({ output: { rows: { columns: ["id", "nom"], rows: [], truncated: false } } });
  vi.stubEnv("META_SYSTEM_TOKEN", "EAAhardeningTokenForTestsOnly00000000000001");
  vi.stubEnv("META_SYSTEM_TOKEN_BACKUP", "");
  vi.stubEnv("META_RETRY_BASE_MS", "0");
  vi.stubEnv("N8N_AUTO_ALERT_WEBHOOK_URL", N8N);
  vi.stubEnv("N8N_ALERT_WEBHOOK_SECRET", "n8n-secret-value");
  vi.stubEnv("RELAY_SHARED_SECRET", "relay-secret-value");
  vi.stubEnv("ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN", "");
  vi.stubGlobal("fetch", vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(target));
    sent.push({ method: (init?.method ?? "GET").toUpperCase(), url: String(target).replace(/access_token=[^&]+/, "access_token=…"), body: typeof init?.body === "string" ? init.body : "" });
    if (url.host === "graph.facebook.com" && url.pathname.endsWith(`/${ACCOUNT}/promote_pages`)) {
      return new Response(JSON.stringify({ data: [{ id: PAGE, name: "La Petite \"Épicerie\"\nVerte" }, { id: "103591049029301", name: "LPEV Pro" }] }), { status: 200 });
    }
    if (url.host === "graph.facebook.com") return new Response(JSON.stringify({ error: { message: "Unsupported get request", code: 100 } }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, result: { appendedRows: 1 } }), { status: 200 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function draft(body: Record<string, unknown> = {}): Promise<string> {
  const res = await CREATE(req({ name: "Créas", metaAccountId: ACCOUNT, ...body }));
  expect(res.status).toBe(201);
  return (await res.json()).routine.id as string;
}
/** Draft → definition applied → dry run done. */
async function ready(steps: unknown[] = [READ, ADS]): Promise<string> {
  const id = await draft();
  expect((await DEFINE(req(proposal(steps)), at(id))).status).toBe(200);
  expect((await DRY_RUN(req(), at(id))).status).toBe(200);
  return id;
}
async function active(steps: unknown[] = [READ, ADS]): Promise<string> {
  const id = await ready(steps);
  const who = session;
  session = CHEF;
  expect((await ACTIVATE(req(), at(id))).status).toBe(200);
  session = who;
  return id;
}

// ── 4. A step given up cannot write after the end of the run ─────────────

describe("4 — l'autorisation d'écriture finit avec l'exécution", () => {
  it("une étape abandonnée qui répond après la fin : son écriture est refusée, rien ne part", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-29T07:00:30Z") });
    const id = await active([SLACK]);
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const late: string[] = [];
    let ctxOfStep: StepContext | null = null;
    behaviours["slack.message"] = async (_step, ctx) => {
      ctxOfStep = ctx;
      await slow; // Meta, Google or n8n that answers very late
      for (const write of [
        () => sendSlackMessage(ctx.write!, { channel: "#c_client", text: "tardif", routine: { id: "r", name: "n" } }),
        () => appendRows(ctx.write!, SHEET, ["id"], [["tardif"]]),
      ]) {
        try { await write(); late.push("écrit"); } catch (e) { late.push(`refusé : ${(e as Error).message}`); }
      }
      return okOutcome();
    };
    const before = sent.length;
    const running = runLocked(id, { trigger: "manual", startedById: LEA.userId, now: new Date(), deadlineAt: Date.now() + 270_000 });
    await vi.advanceTimersByTimeAsync(290_000);
    const ran = await running;
    if (ran.outcome !== "ran") throw new Error(ran.outcome);
    expect(ran.result).toMatchObject({ status: "infra_failed", timedOut: true });
    expect((await getRoutine(id))?.lockedUntil).toBeNull();

    // The run has ended, its lock is given back, and the step wakes up.
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(late).toHaveLength(2);
    expect(sent.slice(before)).toEqual([]);
    for (const answer of late) expect(answer).toMatch(/^refusé : .*autorisation d'écriture a été révoquée/);
    // It had been told to stop, too.
    expect((ctxOfStep as StepContext | null)?.signal?.aborted).toBe(true);
  });

  it("après l'abandon d'une étape, les suivantes ne sont pas lancées", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-29T07:00:30Z") });
    const id = await active([READ, SLACK, { ...SLACK, id: "encore", channel: "#c_autre" }]);
    behaviours["sheet.read"] = () => new Promise(() => {}); // never answers
    let clockValue = 0;
    // The clock of the engine is the test's: the deadline passes only for the step that hangs.
    const running = runRoutine((await getRoutine(id))!, { mode: "live", trigger: "manual", startedById: LEA.userId, deadlineAt: 270_000, clock: () => clockValue });
    await vi.advanceTimersByTimeAsync(290_000);
    clockValue = 1000;
    const result = await running;
    expect(result.steps.map((s) => [s.stepId, s.status])).toEqual([["lire", "failed"], ["prevenir", "skipped"], ["encore", "skipped"]]);
    expect(result).toMatchObject({ status: "infra_failed", timedOut: true });
    expect(seen.filter((s) => s.ctx.mode === "live").map((s) => s.stepId)).toEqual(["lire"]);
  });

  it.each([
    ["succès", () => okOutcome()],
    ["échec", () => ({ ...okOutcome(), status: "failed" as const, error: { class: "functional" as const, message: "Onglet introuvable" } })],
    ["exception", () => { throw new Error("fetch failed"); }],
  ])("%s : l'autorisation est révoquée dès que l'exécution se termine", async (_label, behaviour) => {
    const { assertWriteGuard, isWriteGuard } = await import("@/lib/routines/write-guard-check");
    const id = await active([SLACK]);
    let guard: WriteGuard | null = null;
    let validDuringTheRun = false;
    behaviours["slack.message"] = (_step, ctx) => { guard = ctx.write; validDuringTheRun = isWriteGuard(ctx.write) && ctx.signal?.aborted === false; return behaviour(); };
    const ran = await runLocked(id, { trigger: "manual", startedById: LEA.userId });
    expect(ran.outcome).toBe("ran");
    expect(validDuringTheRun).toBe(true);
    expect(guard).not.toBeNull();
    expect(isWriteGuard(guard)).toBe(false);
    expect(() => assertWriteGuard(guard)).toThrow(/révoquée/);
    await expect(sendSlackMessage(guard!, { channel: "#c_client", text: "après", routine: { id: "r", name: "n" } })).rejects.toThrow(/révoquée/);
    expect(sent.filter((c) => c.url === N8N)).toEqual([]);
  });

  it("une autorisation révoquée ne redevient jamais valable, et une autre exécution n'en est pas touchée", async () => {
    const guards = await import("@/lib/routines/write-guard") as unknown as {
      mintWriteGuard: (mode: "live", runId: string) => WriteGuard; revokeWriteGuard: (g: WriteGuard) => void; isMintedWriteGuard: (g: unknown) => boolean;
    };
    const one = guards.mintWriteGuard("live", "run1");
    const two = guards.mintWriteGuard("live", "run2");
    guards.revokeWriteGuard(one);
    guards.revokeWriteGuard(one);
    expect(guards.isMintedWriteGuard(one)).toBe(false);
    expect(guards.isMintedWriteGuard(two)).toBe(true);
    // Nothing that was not minted can be revoked, or made a guard by being so.
    guards.revokeWriteGuard({ runId: "run2" } as unknown as WriteGuard);
    expect(guards.isMintedWriteGuard(two)).toBe(true);
  });
});

// ── 7. The fingerprint covers where the routine writes ───────────────────

describe("7 — l'empreinte couvre les comptes et le fuseau", () => {
  it.each([
    ["le compte Meta", { metaAccountId: "act_999000111222333" }],
    ["le compte Google", { googleCustomerId: "1112223334" }],
    ["le fuseau", { timezone: "America/New_York" }],
  ])("%s a changé après l'essai à blanc : l'activation est refusée", async (_label, change) => {
    const id = await ready();
    Object.assign(row(id), change);
    session = CHEF;
    const res = await ACTIVATE(req(), at(id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/empreinte/);
    expect(row(id).status).toBe("ready");
  });

  it("le nom de la routine n'en fait pas partie : renommée après l'essai, elle s'active", async () => {
    const id = await ready();
    expect((await PATCH(req({ name: "Autre nom" }), at(id))).status).toBe(200);
    session = CHEF;
    expect((await ACTIVATE(req(), at(id))).status).toBe(200);
    expect(row(id)).toMatchObject({ name: "Autre nom", status: "active" });
  });

  it("la reprise après pause et l'exécution relisent l'empreinte elles aussi", async () => {
    const id = await active();
    expect((await PATCH(req({ action: "pause" }), at(id))).status).toBe(200);
    row(id).metaAccountId = "act_999000111222333";
    // The scope of the test staff is every account: only the fingerprint stands in the way.
    const resumed = await PATCH(req({ action: "resume" }), at(id));
    expect(resumed.status).toBe(409);
    expect(row(id).status).toBe("paused");

    row(id).metaAccountId = ACCOUNT;
    expect((await PATCH(req({ action: "resume" }), at(id))).status).toBe(200);
    row(id).timezone = "America/New_York";
    const ran = await (await RUN(req(), at(id))).json();
    expect(ran.result).toMatchObject({ status: "failed", steps: [] });
    expect(ran.result.error).toMatch(/empreinte/);
    expect(seen.filter((s) => s.ctx.mode === "live")).toEqual([]);
  });
});

// ── 8. The administrator rule, everywhere it matters ─────────────────────

describe("8 — règle administrateur : activer, reprendre, exécuter", () => {
  beforeEach(() => vi.stubEnv("ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN", "1"));

  it("un consultant ne peut ni activer, ni reprendre, ni exécuter une routine qui crée des publicités", async () => {
    const id = await ready();
    const refused = await ACTIVATE(req(), at(id));
    expect(refused.status).toBe(403);
    session = CHEF;
    expect((await ACTIVATE(req(), at(id))).status).toBe(200);

    session = SAM;
    const ran = await RUN(req(), at(id));
    expect(ran.status).toBe(403);
    expect(await ran.json()).toMatchObject({ code: "admin_required", error: expect.stringMatching(/seul un administrateur peut l'exécuter/) });
    expect(seen.filter((s) => s.ctx.mode === "live")).toEqual([]);
    expect(db.routineRun.rows.filter((r) => r.trigger !== "dry_run")).toEqual([]);

    // Pausing stays open to everyone: it stops writes, it starts none.
    expect((await PATCH(req({ action: "pause" }), at(id))).status).toBe(200);
    const resumed = await PATCH(req({ action: "resume", name: "Renommée au passage" }), at(id));
    expect(resumed.status).toBe(403);
    expect(await resumed.json()).toMatchObject({ code: "admin_required", error: expect.stringMatching(/seul un administrateur peut la reprendre/) });
    expect(row(id)).toMatchObject({ status: "paused", nextRunAt: null, name: "Créas" });
  });

  it("un administrateur le peut", async () => {
    const id = await ready();
    session = CHEF;
    expect((await ACTIVATE(req(), at(id))).status).toBe(200);
    expect((await RUN(req(), at(id))).status).toBe(200);
    expect((await PATCH(req({ action: "pause" }), at(id))).status).toBe(200);
    expect((await PATCH(req({ action: "resume" }), at(id))).status).toBe(200);
    expect(row(id).status).toBe("active");
  });

  it("la règle ne touche pas une routine qui n'écrit sur aucune plateforme, ni quand elle est éteinte", async () => {
    const light = await ready([READ, SLACK]);
    session = SAM;
    expect((await ACTIVATE(req(), at(light))).status).toBe(200);
    expect((await RUN(req(), at(light))).status).toBe(200);
    expect((await PATCH(req({ action: "pause" }), at(light))).status).toBe(200);
    expect((await PATCH(req({ action: "resume" }), at(light))).status).toBe(200);

    vi.stubEnv("ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN", "");
    session = LEA;
    const ads = await ready();
    session = SAM;
    expect((await ACTIVATE(req(), at(ads))).status).toBe(200);
    expect((await RUN(req(), at(ads))).status).toBe(200);
    expect((await PATCH(req({ action: "pause" }), at(ads))).status).toBe(200);
    expect((await PATCH(req({ action: "resume" }), at(ads))).status).toBe(200);
  });
});

// ── 10. Account ids, at the door ─────────────────────────────────────────

describe("10 — identifiants de compte à la création de la routine", () => {
  it.each([
    [{ metaAccountId: "act_123" }], [{ metaAccountId: "123" }], [{ metaAccountId: "act_1234567" }],
    [{ metaAccountId: ACCOUNT, googleCustomerId: "12345-6" }], [{ metaAccountId: ACCOUNT, googleCustomerId: "123456" }], [{ metaAccountId: ACCOUNT, googleCustomerId: "476-8893847" }],
  ])("%j est refusé : le module Meta ou l'étape Google le refuserait ensuite", async (body) => {
    const res = await CREATE(req({ name: "Créas", ...body }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/compte (Meta|Google Ads) invalide/);
    expect(db.routine.rows).toEqual([]);
  });

  it("les comptes repris du dashboard passent par la même règle", async () => {
    const bad = await db.dashboard.create({ data: { name: "Ancien", metaAccountId: "act_123", googleCustomerId: null } });
    const good = await db.dashboard.create({ data: { name: "LPEV", metaAccountId: ACCOUNT, googleCustomerId: "476-889-3847" } });
    expect((await CREATE(req({ name: "Créas", dashboardId: bad.id }))).status).toBe(400);
    const res = await CREATE(req({ name: "Créas", dashboardId: good.id }));
    expect(res.status).toBe(201);
    expect((await res.json()).routine).toMatchObject({ metaAccountId: ACCOUNT, googleCustomerId: "476-889-3847" });
  });
});

// ── C. A dry run that showed nothing ─────────────────────────────────────

describe("C — essai à blanc qui n'a rien trouvé à créer", () => {
  it("la réponse de l'essai avertit, le journal le garde, et l'activation reste possible", async () => {
    const id = await draft();
    expect((await DEFINE(req(proposal([READ, ADS])), at(id))).status).toBe(200);
    const res = await DRY_RUN(req(), at(id));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, warning: "L'essai n'a rien trouvé à créer : vous activez sans avoir vu d'exemple." });
    expect(body.result.warnings).toEqual([body.warning]);
    expect(String(db.routineEvent.rows.find((e) => e.kind === "dry_run")?.detail)).toContain("vous activez sans avoir vu d'exemple");

    session = CHEF;
    expect((await ACTIVATE(req(), at(id))).status).toBe(200);
  });

  it("aucun avertissement quand l'essai montre au moins une publicité", async () => {
    const id = await draft();
    expect((await DEFINE(req(proposal([READ, ADS])), at(id))).status).toBe(200);
    behaviours["meta.create_ads"] = () => okOutcome({ planned: [{ target: "meta", summary: "Créer en pause « Pub 1 »", itemKey: "c1", preview: {} }] });
    const body = await (await DRY_RUN(req(), at(id))).json();
    expect(body).toMatchObject({ ok: true, warning: null, result: { warnings: [], counts: { adsCreated: 1 } } });
  });
});

// ── E. The Facebook Page, picked in the form ─────────────────────────────

describe("E — Page Facebook choisie à la création", () => {
  it("la liste des pages que le compte peut promouvoir, en lecture seule, dans le périmètre de la personne", async () => {
    const pages = { GET: sure((await import("@/app/api/routines/pages/route")).GET) };
    const res = await pages.GET(new NextRequest(`http://x/api/routines/pages?metaAccountId=${ACCOUNT}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pages: [{ id: PAGE, name: "La Petite \"Épicerie\"\nVerte" }, { id: "103591049029301", name: "LPEV Pro" }], complete: true });
    expect(sent.every((c) => c.method === "GET")).toBe(true);

    expect((await pages.GET(new NextRequest("http://x/api/routines/pages?metaAccountId=act_123"))).status).toBe(400);
    session = null;
    expect((await pages.GET(new NextRequest(`http://x/api/routines/pages?metaAccountId=${ACCOUNT}`))).status).toBe(401);
    // A person whose scope is a list of accounts reads the pages of those accounts, not of another.
    session = { userId: "u-scoped", role: "consultant", baseRole: "consultant", user: { email: "scoped@impulse.test" } };
    await db.user.create({ data: { id: "u-scoped", role: "consultant" } });
    await db.userAdAccount.create({ data: { userId: "u-scoped", platform: "meta", accountId: ACCOUNT } });
    const calls = sent.length;
    expect((await pages.GET(new NextRequest("http://x/api/routines/pages?metaAccountId=act_999000111222333"))).status).toBe(403);
    expect(sent.length).toBe(calls);
    expect((await pages.GET(new NextRequest(`http://x/api/routines/pages?metaAccountId=${ACCOUNT}`))).status).toBe(200);
  });

  it("la Page choisie est relue dans la liste du compte, gardée avec la conversation et transmise à l'IA", async () => {
    const id = await draft({ pageId: PAGE });
    // What the browser says of the Page is not kept: its name is the one Meta gives, on one line.
    expect(JSON.parse(String(row(id).chatJson))).toEqual({ context: { page: { id: PAGE, name: "La Petite Épicerie Verte" } } });

    const { readRoutineContext } = await import("@/lib/routines/context");
    const { buildRoutineComposePrompt, buildRoutineRelayBody } = await import("@/lib/routines/compose-prompt");
    const page = readRoutineContext(String(row(id).chatJson)).page;
    const prompt = buildRoutineComposePrompt({ name: "Créas", clientName: "LPEV", metaAccountId: ACCOUNT, googleCustomerId: null, timezone: "Europe/Paris", page });
    expect(prompt).toContain(`Page Facebook choisie par le consultant : "La Petite Épicerie Verte", identifiant ${PAGE} (à utiliser pour "pageId")`);
    expect(prompt).toMatch(/utilise son identifiant pour "pageId" sans le redemander/);
    const relay = buildRoutineRelayBody({ routine: { ...(row(id) as never as Parameters<typeof buildRoutineRelayBody>[0]["routine"]), page }, userId: LEA.userId, author: null, messages: [] });
    expect(relay.systemPrompt).toContain(`identifiant ${PAGE}`);

    // Saving the conversation leaves the Page where it is.
    const saved = await CHAT_PUT(new NextRequest("http://x", { method: "PUT", body: JSON.stringify({ messages: [{ role: "user", content: "Bonjour" }], proposals: {} }) }), at(id));
    expect(saved.status).toBe(200);
    expect(JSON.parse(String(row(id).chatJson))).toMatchObject({ messages: [{ role: "user", content: "Bonjour" }], context: { page: { id: PAGE } } });
    expect((await (await CHAT_GET(new NextRequest("http://x"), at(id))).json()).messages).toHaveLength(1);
  });

  it("sans Page choisie, rien ne change ; une Page qui n'est pas du compte est refusée", async () => {
    const id = await draft();
    expect(String(row(id).chatJson)).toBe("{}");
    const { buildRoutineComposePrompt } = await import("@/lib/routines/compose-prompt");
    expect(buildRoutineComposePrompt({ name: "Créas", clientName: "LPEV", metaAccountId: ACCOUNT, googleCustomerId: null, timezone: "Europe/Paris" }))
      .toContain("Page Facebook choisie par le consultant : aucune");

    for (const body of [{ pageId: "999999999999" }, { pageId: "{{row.page}}" }, { pageId: 12 }, { metaAccountId: undefined, pageId: PAGE }]) {
      const res = await CREATE(req({ name: "Créas", metaAccountId: ACCOUNT, ...body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(db.routine.rows).toHaveLength(1);
    expect(sent.every((c) => c.method === "GET")).toBe(true);
  });
});
