/**
 * Routines — hardening, second series, the routes: the REAL routes and the
 * REAL engine, the step handlers replaced (routines-engine-fakes.ts).
 *
 * Every case fails on the commit of the second review (c9d204f) and passes
 * now, except those marked « garde-fou ». What did not exist then is imported
 * inside the case that needs it.
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
import { behaviours, db, okOutcome, resetDb, resetSteps, seen } from "./routines-engine-fakes";

const sure = <A extends unknown[]>(h: (...a: A) => Promise<Response | undefined>) => async (...a: A): Promise<Response> => (await h(...a))!;
const CREATE = sure(listRoute.POST), GET = sure(oneRoute.GET);
const DEFINE = sure(definitionRoute.POST), DRY_RUN = sure(dryRunRoute.POST), ACTIVATE = sure(activateRoute.POST), RUN = sure(runRoute.POST);
const CHAT_PUT = sure(assistantRoute.PUT);

const LEA: Session = { userId: "u-lea", role: "admin", baseRole: "consultant", user: { email: "lea@impulse.test" } };
const SAM: Session = { userId: "u-sam", role: "admin", baseRole: "consultant", user: { email: "sam@impulse.test" } };
const CHEF: Session = { userId: "u-admin", role: "admin", baseRole: "admin", user: { email: "chef@impulse.test" } };

const ACCOUNT = "act_564381881705822";
const ADSET = "120210000000000002";
/** Ads Meta knows, by id. */
const ads = new Map<string, { name: string; status: string; adset_id: string }>();
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
  resetDb(); resetSteps(); sent.length = 0; ads.clear();
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
    const ad = url.host === "graph.facebook.com" ? ads.get(url.pathname.split("/").pop() ?? "") : undefined;
    if (ad) return new Response(JSON.stringify({ id: url.pathname.split("/").pop(), name: ad.name, status: ad.status, effective_status: ad.status, adset_id: ad.adset_id }), { status: 200 });
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

const events = (kind: string) => db.routineEvent.rows.filter((e) => e.kind === kind);
const itemRow = (id: string) => db.routineItem.rows.find((r) => r.id === id)!;
async function item(routineId: string, rowKey: string, data: Record<string, unknown> = {}): Promise<string> {
  const created = await db.routineItem.create({ data: { routineId, runId: "old", stepId: "creer", itemKey: `${ADSET}:${rowKey}`, label: `Visuel ${rowKey}`, status: "uncertain", ...data } });
  return String(created.id);
}
type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string; itemId: string }> }) => Promise<Response | undefined>;
async function resolve(routineId: string, itemId: string, body: unknown): Promise<Response> {
  const route = await import("@/app/api/routines/[id]/items/[itemId]/route") as unknown as { POST: Handler };
  return (await route.POST(req(body), { params: Promise.resolve({ id: routineId, itemId }) }))!;
}
async function listed(routineId: string): Promise<Response> {
  const route = await import("@/app/api/routines/[id]/items/route");
  return (await sure(route.GET)(new NextRequest("http://x"), at(routineId)))!;
}

// ── N3 (c). « J'ai vérifié » ──────────────────────────────────────────────

describe("N3 (c) — « J'ai vérifié » : lever un élément incertain", () => {
  it("la liste « Lignes à vérifier » : incertains et abandonnés, avec la clé lue par le consultant", async () => {
    const id = await active();
    await item(id, "c1");
    await item(id, "c2", { status: "failed", attempts: 3, error: "Image refusée" });
    await item(id, "c3", { status: "failed", attempts: 1 });
    await item(id, "c4", { status: "created", externalId: "90000004" });
    const res = await listed(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: Record<string, unknown>) => [i.rowKey, i.adsetId, i.status, i.attempts]).sort()).toEqual([
      ["c1", ADSET, "uncertain", 1], ["c2", ADSET, "abandoned", 3],
    ]);
    const { toItemsToCheck } = await import("@/components/routines/routine-model") as unknown as { toItemsToCheck: (raw: unknown) => Array<Record<string, unknown>> };
    expect(toItemsToCheck(body.items).find((i) => i.rowKey === "c2")).toMatchObject({ status: "abandoned", error: "Image refusée", label: "Visuel c2" });
  });

  it("« la publicité existe » : relue côté serveur, en pause dans l'ensemble de la ligne, la ligne est close et journalisée avec l'auteur", async () => {
    const id = await active();
    const itemId = await item(id, "c1");
    ads.set("90000555", { name: "Visuel c1", status: "PAUSED", adset_id: ADSET });
    session = SAM;
    const before = sent.length;
    const res = await resolve(id, itemId, { outcome: "exists", adId: "90000555" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, item: { status: "created", externalId: "90000555" } });
    expect(itemRow(itemId)).toMatchObject({ status: "created", externalId: "90000555", error: null });
    // The ad was read, nothing was written on Meta.
    expect(sent.slice(before).map((c) => c.method)).toEqual(["GET"]);
    expect(events("item_resolved")).toHaveLength(1);
    expect(events("item_resolved")[0]).toMatchObject({ userId: SAM.userId, userEmail: SAM.user.email, userRole: "consultant" });
    expect(String(events("item_resolved")[0].detail)).toMatch(/Ligne « c1 » : vérifiée, la publicité 90000555 existe .*statut PAUSED.*Ligne close/);
    // Settled: it is no longer in the list, and cannot be settled again.
    expect((await (await listed(id)).json()).items).toEqual([]);
    expect((await resolve(id, itemId, { outcome: "retry" })).status).toBe(409);
  });

  it("la publicité existe mais n'est pas en pause : son identifiant est gardé, la ligne reste à vérifier", async () => {
    const id = await active();
    const itemId = await item(id, "c1");
    ads.set("90000555", { name: "Visuel c1", status: "ACTIVE", adset_id: ADSET });
    const res = await resolve(id, itemId, { outcome: "exists", adId: "90000555" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ item: { status: "uncertain", externalId: "90000555", adStatus: "ACTIVE" } });
    expect(itemRow(itemId)).toMatchObject({ status: "uncertain", externalId: "90000555" });
    // With the id of an ad, the row never leaves for a creation again.
    expect((await resolve(id, itemId, { outcome: "retry" })).status).toBe(409);
    expect(itemRow(itemId)).toMatchObject({ status: "uncertain", externalId: "90000555" });
  });

  it.each([
    ["d'un autre ensemble de publicités", { adId: "90000555" }, () => ads.set("90000555", { name: "x", status: "PAUSED", adset_id: "120210000000000777" }), 422, /n'est pas dans l'ensemble de publicités/],
    ["introuvable dans Meta", { adId: "90000556" }, () => {}, 422, /introuvable dans Meta/],
    ["déjà celle d'une autre ligne", { adId: "90000004" }, () => ads.set("90000004", { name: "x", status: "PAUSED", adset_id: ADSET }), 422, /déjà celle d'une autre ligne/],
    ["dont l'identifiant n'en est pas un", { adId: "{{row.id}}" }, () => {}, 400, /identifiant de publicité invalide/],
  ])("publicité %s : refus, rien ne change", async (_label, body, arrange, status, message) => {
    const id = await active();
    const itemId = await item(id, "c1");
    await item(id, "c4", { status: "created", externalId: "90000004" });
    arrange();
    const res = await resolve(id, itemId, { outcome: "exists", ...body });
    expect(res.status).toBe(status);
    expect((await res.json()).error).toMatch(message);
    expect(itemRow(itemId)).toMatchObject({ status: "uncertain", externalId: null });
    expect(events("item_resolved")).toEqual([]);
  });

  it("« rien n'a été créé, réessayer » : l'élément repart pour une tentative, et une seule", async () => {
    const id = await active();
    const doubt = await item(id, "c1");
    const givenUp = await item(id, "c2", { status: "failed", attempts: 3, error: "Image refusée" });
    expect((await resolve(id, doubt, { outcome: "retry" })).status).toBe(200);
    expect((await resolve(id, givenUp, { outcome: "retry" })).status).toBe(200);
    expect(itemRow(doubt)).toMatchObject({ status: "failed", attempts: 1, externalId: null });
    expect(itemRow(givenUp)).toMatchObject({ status: "failed", attempts: 2, externalId: null });
    expect(events("item_resolved").map((e) => [e.userId, String(e.detail)])).toEqual([
      [LEA.userId, expect.stringMatching(/Ligne « c1 » : vérifiée, rien n'avait été créé/)],
      [LEA.userId, expect.stringMatching(/Ligne « c2 » : vérifiée, rien n'avait été créé/)],
    ]);
    // The store gives it to the next run as one to create: one attempt left for the row given up.
    const { peekItem } = await import("@/lib/routines/store");
    expect(await peekItem(id, `${ADSET}:c2`)).toMatchObject({ state: "claimed", attempts: 3 });
    expect(sent.filter((c) => c.url.includes("graph.facebook.com"))).toEqual([]);
  });

  it("réservée au personnel, à la routine de l'élément, et à une issue connue", async () => {
    const id = await active();
    const other = await active();
    const itemId = await item(id, "c1");
    expect((await resolve(other, itemId, { outcome: "retry" })).status).toBe(404);
    expect((await resolve(id, itemId, { outcome: "delete" })).status).toBe(400);
    expect((await resolve(id, itemId, {})).status).toBe(400);
    session = { userId: "u-client", role: "client", baseRole: "client", user: { email: "client@exemple.fr" } };
    expect((await resolve(id, itemId, { outcome: "retry" })).status).toBe(403);
    expect((await listed(id)).status).toBe(403);
    session = null;
    expect((await resolve(id, itemId, { outcome: "retry" })).status).toBe(401);
    expect(itemRow(itemId)).toMatchObject({ status: "uncertain" });
    expect(events("item_resolved")).toEqual([]);
  });
});

// ── N2 (b), N1. What a proposal may not do, what it must say ─────────────

describe("N2 (b) et N1 — la proposition face à la routine", () => {
  const other = { ...ADS, pageId: "103591049029301" };
  const block = (steps: unknown[]) => `Voici.\n\`\`\`routine\n${JSON.stringify(proposal(steps))}\n\`\`\``;
  const thread = (steps: unknown[]) => [{ role: "user", content: "x" }, { role: "assistant", content: block(steps) }];
  const put = (id: string, steps: unknown[]) => CHAT_PUT(new NextRequest("http://x", { method: "PUT", body: JSON.stringify({ messages: thread(steps), proposals: {} }) }), at(id));

  it("Page choisie au formulaire : la proposition de l'IA avec une autre Page est invalide sur la carte, et refusée à l'application", async () => {
    const id = await draft({ pageId: PAGE });
    const checks = (await (await put(id, [READ, other])).json()).checks;
    expect(checks.m1.ok).toBe(false);
    expect(checks.m1.errors.join(" ")).toContain(`la Page Facebook choisie à la création de la routine est ${PAGE}`);
    const applied = await DEFINE(req(proposal([READ, other])), at(id));
    expect(applied.status).toBe(400);
    expect((await applied.json()).errors.join(" ")).toContain(`"pageId": "${PAGE}"`);
    expect(row(id)).toMatchObject({ status: "draft", definitionHash: "" });

    expect((await (await put(id, [READ, ADS])).json()).checks.m1).toMatchObject({ ok: true });
    expect((await DEFINE(req(proposal([READ, ADS])), at(id))).status).toBe(200);
  });

  it("garde-fou — sans Page choisie, la Page de la proposition relève des contrôles du serveur", async () => {
    const id = await draft();
    expect((await (await put(id, [READ, other])).json()).checks.m1).toMatchObject({ ok: true });
  });

  it("l'ensemble de publicités change : la carte et la réponse de l'application le disent en clair", async () => {
    const id = await active();
    for (const key of ["c1", "c2"]) await item(id, key, { status: "created", externalId: `9000000${key.slice(1)}` });
    await item(id, "c3", { status: "failed" });
    const moved = { ...ADS, adsetId: "120210000000000009" };
    const notice = "L'ensemble de publicités a changé : les 2 lignes déjà traitées dans l'ancien ensemble seront créées à nouveau dans le nouveau.";
    expect((await (await put(id, [READ, moved])).json()).checks.m1).toMatchObject({ ok: true, notices: [notice] });
    // Same ad set, step renamed by the AI: nothing to announce, nothing will be created again.
    expect((await (await put(id, [READ, { ...ADS, id: "creation" }])).json()).checks.m1).toMatchObject({ ok: true, notices: [] });

    const applied = await DEFINE(req(proposal([READ, moved])), at(id));
    expect(applied.status).toBe(200);
    expect((await applied.json()).notices).toEqual([notice]);
  });
});

// ── N8, M4d ──────────────────────────────────────────────────────────────

describe("N8 — « Exécuter maintenant » : le message exact", () => {
  async function runWhile(id: string, change: () => void): Promise<Response> {
    const original = db.routine.findUnique;
    let n = 0;
    // Read active by the route, changed before the lock is taken.
    db.routine.findUnique = (async (args: never) => { const r = await original(args); if (++n === 2) change(); return r; }) as typeof original;
    try { return await RUN(req(), at(id)); } finally { db.routine.findUnique = original; }
  }

  it("routine arrêtée entre-temps : « vient d'être arrêtée », pas « déjà en cours »", async () => {
    const id = await active([SLACK]);
    const res = await runWhile(id, () => { row(id).status = "error"; });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("not_active");
    expect(body.error).toMatch(/vient d'être arrêtée après des échecs répétés/);
    expect(body.error).not.toMatch(/déjà en cours/);
    expect(body.routine).toMatchObject({ status: "error" });
    expect(seen.filter((s) => s.ctx.mode === "live")).toEqual([]);
  });

  it("routine mise en pause entre-temps : « n'est plus active »", async () => {
    const id = await active([SLACK]);
    const body = await (await runWhile(id, () => { row(id).status = "paused"; })).json();
    expect(body).toMatchObject({ code: "not_active", error: expect.stringMatching(/n'est plus active/) });
  });

  it("garde-fou — verrou tenu par une autre exécution : « déjà en cours d'exécution »", async () => {
    const id = await active([SLACK]);
    row(id).lockedUntil = new Date(Date.now() + 300_000);
    const res = await RUN(req(), at(id));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "busy", error: "Cette routine est déjà en cours d'exécution." });
  });
});

describe("M4d — l'activation est conditionnée à l'empreinte dans la mise à jour elle-même", () => {
  it("une définition appliquée entre les contrôles et l'activation : l'activation n'a pas lieu", async () => {
    const id = await ready();
    session = CHEF;
    const original = db.routine.updateMany;
    let raced = false;
    db.routine.updateMany = (async (args: never) => {
      if (!raced) {
        raced = true;
        // Another person applies a definition at this very instant: new fingerprint, dry run forgotten.
        Object.assign(row(id), { definitionHash: "f".repeat(64), dryRunHash: null, dryRunAt: null });
      }
      return original(args);
    }) as typeof original;
    const res = await ACTIVATE(req(), at(id));
    db.routine.updateMany = original;
    expect(raced).toBe(true);
    expect(res.status).toBe(409);
    expect(row(id)).toMatchObject({ status: "ready", nextRunAt: null, activatedById: null });
    expect(events("activated")).toEqual([]);
  });

  it("l'essai à blanc refait entre-temps sur une autre définition ne suffit pas non plus", async () => {
    const id = await ready();
    session = CHEF;
    const original = db.routine.updateMany;
    let raced = false;
    db.routine.updateMany = (async (args: never) => {
      if (!raced) { raced = true; Object.assign(row(id), { dryRunHash: "e".repeat(64) }); }
      return original(args);
    }) as typeof original;
    const res = await ACTIVATE(req(), at(id));
    db.routine.updateMany = original;
    expect(res.status).toBe(409);
    expect(row(id).status).toBe("ready");
  });
});

// ── N5, and the journal of the dry run ───────────────────────────────────

describe("N5 — la fiche de la routine dit sa dégradation", () => {
  it("GET rend le nombre d'exécutions sans succès complet, la dernière erreur et les lignes à vérifier", async () => {
    const id = await active([READ, SLACK]);
    expect((await (await GET(new NextRequest("http://x"), at(id))).json()).routine).toMatchObject({ degradedRuns: 0, degradedError: null, itemsToCheck: 0 });
    behaviours["sheet.read"] = () => ({ ...okOutcome(), status: "failed" as const, error: { class: "infra" as const, message: "Relay inaccessible" } });
    for (let n = 0; n < 4; n++) expect((await RUN(req(), at(id))).status).toBe(200);
    await item(id, "c1");
    const body = (await (await GET(new NextRequest("http://x"), at(id))).json()).routine;
    expect(body).toMatchObject({ status: "active", degradedRuns: 4, degradedAtLeast: false, degradedError: "Relay inaccessible", itemsToCheck: 1 });
    const { degradedBanner, toRoutineView } = await import("@/components/routines/routine-model") as unknown as {
      degradedBanner: (r: unknown) => { title: string; error: string | null } | null; toRoutineView: (raw: unknown) => unknown;
    };
    expect(degradedBanner(toRoutineView(body))).toEqual({ title: "Routine dégradée depuis 4 exécutions : aucune n'a entièrement réussi.", error: "Relay inaccessible" });
    // One event, whatever the number of runs.
    expect(events("degraded_notified")).toHaveLength(1);

    behaviours["sheet.read"] = () => okOutcome({ output: { rows: { columns: ["id", "nom"], rows: [{ id: "c1", nom: "x" }], truncated: false } } });
    expect((await RUN(req(), at(id))).status).toBe(200);
    expect((await (await GET(new NextRequest("http://x"), at(id))).json()).routine).toMatchObject({ degradedRuns: 0, degradedError: null });
  });
});

describe("reste du défaut 8 — le journal de l'essai à blanc compte par nature d'écriture", () => {
  it("publicités, lignes de Sheet et messages ne sont plus additionnés", async () => {
    const id = await draft();
    expect((await DEFINE(req(proposal([READ, ADS, SLACK])), at(id))).status).toBe(200);
    behaviours["sheet.read"] = () => okOutcome({ output: { rows: { columns: ["id", "nom"], rows: [{ id: "c1", nom: "x" }], truncated: false } } });
    behaviours["meta.create_ads"] = (_step, ctx) => okOutcome({
      output: { rows: ctx.input! },
      planned: [
        { target: "meta", summary: "Créer « Pub 1 »", itemKey: "c1", preview: {} }, { target: "meta", summary: "Créer « Pub 2 »", itemKey: "c2", preview: {} },
        { target: "sheet", summary: "Écrire le statut de 2 ligne(s)", preview: {} },
      ],
      counts: { adsCreated: 2, sheetRows: 2 },
    });
    behaviours["slack.message"] = () => okOutcome({ planned: [{ target: "slack", summary: "Message", preview: {} }], counts: { messages: 1 } });
    expect((await DRY_RUN(req(), at(id))).status).toBe(200);
    const detail = String(events("dry_run")[0].detail);
    expect(detail).toBe("2 publicités à créer, 2 lignes de Sheet à écrire, 1 message à envoyer");
    expect(detail).not.toMatch(/écriture\(s\) prévue\(s\)/);
  });
});

vi.setConfig({ testTimeout: 60_000 });
