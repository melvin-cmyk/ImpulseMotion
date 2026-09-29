/**
 * Routines — hardening: one case (or more) per defect reproduced by the
 * independent review, and per decision of the lead developer.
 *
 * REAL engine, registry, steps, services and cron route. Only the outside is
 * simulated: `fetch` (Graph API of Meta, relay Sheets routes, n8n webhook) and
 * Prisma, held in memory (routines-engine-fakes.ts).
 *
 * Every case fails on the commit the review was made on (aabfd71) and passes
 * now. What did not exist then is imported inside the case that needs it, so
 * that the file runs on both and each case fails for its own reason.
 *
 * The cases that need the step handlers replaced (routes, a step that answers
 * after the end of the run) are in routines-hardening-routes.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", async () => ({ prisma: (await import("./routines-engine-fakes")).db }));

import { db, resetDb } from "./routines-engine-fakes";

const TOKEN = "EAAhardeningTokenForTestsOnly00000000000001";
const ACCOUNT = "564381881705822";
const OTHER_ACCOUNT = "999000111222333";
const CAMPAIGN = "120233510168830703";
const ADSET = "120250524723890703";
const ADSET_2 = "120250524723890999";
const PAGE = "103591049029300";
const SHEET = { spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", tab: "Créas" };
const N8N = "https://n8n.example.org/webhook/impulsemotion-auto-alerts";
const COLUMNS = ["id", "nom", "texte", "lien", "image", "statut", "id_pub", "erreur"];

// ── The outside world ────────────────────────────────────────────────────

interface Call { method: string; url: string; path: string; host: string; body: Record<string, unknown> | null }
interface Ad { id: string; name: string; status: string; adset_id: string }

const world = {
  calls: [] as Call[],
  ads: [] as Ad[],
  /** Status Meta gives an ad when it is created, whatever was asked: "ACTIVE" is the ad that did not stay paused. */
  createdAs: null as string | null,
  /** By ad name: Meta refuses the POST that creates the ad. */
  refused: new Set<string>(),
  /** Ads Meta no longer finds by their id (deleted). */
  gone: new Set<string>(),
  sheet: [] as Array<Record<string, unknown>>,
  sheetColumns: COLUMNS,
  slack: [] as Array<{ channel: string; text: string }>,
  /** Called when a Slack message arrives: what the routine looks like at that instant. */
  onSlack: null as (() => void) | null,
  /** Called when the Sheet is read. */
  onSheetRead: null as (() => void) | null,
  nextId: 1,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sheetRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id, nom: `Visuel ${id}`, texte: `Texte ${id}`, lien: `https://www.example.org/p/${id}`, image: `https://cdn.example.org/${id}.jpg`,
  statut: null, id_pub: null, erreur: null, ...extra,
});

function router(target: string | URL | Request, init?: RequestInit): Response {
  const url = new URL(String(target));
  const method = (init?.method ?? "GET").toUpperCase();
  let body: Record<string, unknown> | null = null;
  if (init?.body instanceof URLSearchParams) body = Object.fromEntries(init.body.entries());
  else if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = { raw: init.body }; } }
  const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
  world.calls.push({ method, url: String(target), path, host: url.host, body });

  if (url.host === "graph.facebook.com") {
    const adsets = [ADSET, ADSET_2];
    if (method === "GET") {
      const adset = adsets.find((a) => path === `/${a}`);
      if (adset) return json({ id: adset, name: "Ensemble", account_id: ACCOUNT, campaign_id: CAMPAIGN, status: "ACTIVE" });
      if (path === `/${CAMPAIGN}`) return json({ id: CAMPAIGN, name: "Campagne", account_id: ACCOUNT, status: "ACTIVE" });
      if (path === `/${PAGE}`) return json({ id: PAGE, name: "La Petite Épicerie Verte" });
      if (path === `/act_${ACCOUNT}/promote_pages`) return json({ data: [{ id: PAGE, name: "La Petite Épicerie Verte" }, { id: "103591049029301", name: "LPEV Pro" }] });
      if (path === `/act_${ACCOUNT}/adcreatives`) return json({ data: [] });
      const listed = adsets.find((a) => path === `/${a}/ads`);
      if (listed) {
        const needle = String((JSON.parse(url.searchParams.get("filtering") ?? "[]") as Array<{ value?: string }>)[0]?.value ?? "");
        return json({ data: world.ads.filter((a) => a.adset_id === listed && a.name.includes(needle)).map((a) => ({ id: a.id, name: a.name, status: a.status, effective_status: a.status })) });
      }
      const ad = world.ads.find((a) => `/${a.id}` === path);
      if (ad && !world.gone.has(ad.id)) return json({ id: ad.id, name: ad.name, status: ad.status, effective_status: ad.status, adset_id: ad.adset_id });
      return json({ error: { message: "Unsupported get request. Object does not exist", type: "GraphMethodException", code: 100, error_subcode: 33 } }, 400);
    }
    if (path === `/act_${ACCOUNT}/adcreatives`) return json({ id: String(80000000 + world.nextId++) });
    if (path === `/act_${ACCOUNT}/ads`) {
      const name = String(body?.name ?? "");
      if (world.refused.has(name)) return json({ error: { message: "Invalid parameter", type: "OAuthException", code: 100, error_user_msg: "L'image est trop petite." } }, 400);
      const ad: Ad = { id: String(90000000 + world.nextId++), name, status: world.createdAs ?? String(body?.status ?? "ACTIVE"), adset_id: String(body?.adset_id ?? "") };
      world.ads.push(ad);
      return json({ id: ad.id });
    }
    // The pause asked of an ad that did not stay paused: Meta says yes, the ad stays as it is.
    if (world.ads.some((a) => `/${a.id}` === path)) return json({ success: true });
    return json({ error: { message: "Unsupported post request", code: 100 } }, 400);
  }
  if (url.pathname === "/api/sheets/read") {
    world.onSheetRead?.();
    return json({ result: { columns: world.sheetColumns, rows: world.sheet, rowNumbers: world.sheet.map((_, i) => i + 2), truncated: false, warnings: [] } });
  }
  if (url.pathname === "/api/sheets/update") {
    const updates = (body as { updates: Array<{ row: number; column: string; value: unknown }> }).updates;
    for (const u of updates) if (world.sheet[u.row - 2]) world.sheet[u.row - 2][u.column] = u.value === "" ? null : u.value;
    return json({ result: { updatedCells: updates.length } });
  }
  if (String(target) === N8N) {
    world.onSlack?.();
    world.slack.push({ channel: String(body?.channel), text: String(body?.text) });
    return json({ ok: true });
  }
  throw new Error(`appel non prévu par l'essai : ${method} ${String(target)}`);
}

const posts = () => world.calls.filter((c) => c.method === "POST");
const adPosts = () => posts().filter((c) => c.path === `/act_${ACCOUNT}/ads`);
const metaWrites = () => posts().filter((c) => c.host === "graph.facebook.com");
const statuses = () => world.sheet.map((r) => r.statut);

// ── Routines ─────────────────────────────────────────────────────────────

const READ = { id: "lire", type: "sheet.read", sheet: SHEET, requiredColumns: ["id", "nom", "texte", "lien", "image"] };
const NEW_ROWS = { id: "nouvelles", type: "rows.filter", where: [{ column: "statut", op: "empty" }] };
const CREATE = {
  id: "creer", type: "meta.create_ads", campaignId: CAMPAIGN, adsetId: ADSET, pageId: PAGE, keyColumn: "id",
  mapping: { adName: "{{row.nom}}", primaryText: "{{row.texte}}", linkUrl: "{{row.lien}}", mediaType: "image", mediaUrl: "{{row.image}}" },
  writeBack: { sheet: SHEET, statusColumn: "statut", adIdColumn: "id_pub", errorColumn: "erreur" },
};
const CREATE_ONLY = { ...CREATE, writeBack: undefined };
const SLACK = { id: "prevenir", type: "slack.message", channel: "#c_client", text: "Bilan du {{run.date}}" };

const proposal = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  name: "Créas de la semaine", description: "d", schedule: { kind: "daily", time: "09:00" },
  definition: { version: 1, steps }, explanation: "e", assumptions: [], ...extra,
});

type Stored = NonNullable<Awaited<ReturnType<typeof import("@/lib/routines/store")["getRoutine"]>>>;

/** A routine whose definition went through the real validation, stored as the application stores it. */
async function applied(steps: unknown[], extra: Record<string, unknown> = {}, routineId?: string): Promise<Stored> {
  const { validateProposal } = await import("@/lib/routines/validate");
  const { applyDefinition, createRoutine, getRoutine } = await import("@/lib/routines/store");
  const { writesPlatform } = await import("@/lib/routines/steps");
  const id = routineId ?? (await createRoutine({ name: "x", clientName: "LPEV", dashboardId: null, metaAccountId: `act_${ACCOUNT}`, googleCustomerId: null }, { userId: "u1" })).id;
  const checked = validateProposal(proposal(steps, extra));
  if (!checked.ok) throw new Error(checked.errors.join(" | "));
  const p = checked.value;
  await applyDefinition(id, { ...p, writesPlatform: writesPlatform(p.definition.steps) }, { userId: "u1" });
  return (await getRoutine(id))!;
}

const reload = async (id: string) => (await (await import("@/lib/routines/store")).getRoutine(id))!;
/** Active, due a minute before `now`. */
async function activated(routine: Stored, now: Date): Promise<Stored> {
  const { setStatus } = await import("@/lib/routines/store");
  await setStatus(routine.id, ["ready"], "active", { nextRunAt: new Date(now.getTime() - 60_000), activatedById: "u1" });
  return reload(routine.id);
}
async function live(routine: Stored, extra: Record<string, unknown> = {}) {
  const { runRoutine } = await import("@/lib/routines/engine");
  return runRoutine(await reload(routine.id), { mode: "live", trigger: "manual", startedById: "u1", ...extra });
}
async function dry(routine: Stored) {
  const { runRoutine } = await import("@/lib/routines/engine");
  return runRoutine(await reload(routine.id), { mode: "dry_run", trigger: "dry_run", startedById: "u1" });
}

const items = () => db.routineItem.rows;
const itemOf = (rowKey: string) => items().find((i) => String(i.itemKey) === rowKey || String(i.itemKey).endsWith(`:${rowKey}`))!;
/** The answer to a reservation, whichever form it has (a word on the commit of the review, an object since). */
const stateOf = (claim: unknown) => (typeof claim === "string" ? claim : (claim as { state: string }).state);
const stepOf = (result: { steps: Array<{ stepId: string }> }, id: string) => result.steps.find((s) => s.stepId === id) as unknown as {
  status: string; planned: Array<{ target: string; itemKey?: string }>; written: Array<{ itemKey?: string; externalId?: string; attached?: boolean }>;
  warnings: string[]; timedOut?: boolean; counts: Record<string, number>; error?: { class: string; message: string; scope?: string };
  output: { rows?: { rows: Array<Record<string, unknown>> } };
};

const NOW = new Date("2026-09-29T07:00:30Z");

beforeEach(async () => {
  resetDb();
  world.calls.length = 0; world.ads.length = 0; world.slack.length = 0;
  world.createdAs = null; world.refused.clear(); world.gone.clear();
  world.sheet = ["c1", "c2", "c3"].map((id) => sheetRow(id));
  world.sheetColumns = COLUMNS;
  world.onSlack = null; world.onSheetRead = null; world.nextId = 1;
  vi.stubEnv("META_SYSTEM_TOKEN", TOKEN);
  vi.stubEnv("META_SYSTEM_TOKEN_BACKUP", "");
  vi.stubEnv("META_RETRY_BASE_MS", "0");
  vi.stubEnv("N8N_AUTO_ALERT_WEBHOOK_URL", N8N);
  vi.stubEnv("N8N_ALERT_WEBHOOK_SECRET", "n8n-secret-value");
  vi.stubEnv("N8N_ROUTINES_WEBHOOK_URL", "");
  vi.stubEnv("RELAY_SHARED_SECRET", "relay-secret-value");
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN", "");
  vi.stubGlobal("fetch", vi.fn(async (t: string | URL | Request, i?: RequestInit) => router(t, i)));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await db.user.create({ data: { id: "u1", role: "consultant", email: "lea@impulse-analytics.com" } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

// ── 1. An ad is never created twice ──────────────────────────────────────

describe("1 — une publicité n'est jamais créée en double", () => {
  it("(a) publicité créée mais relue ACTIVE, puis renommée dans Meta : elle est relue par son identifiant, aucune autre n'est créée", async () => {
    world.sheet = [sheetRow("c1")];
    const routine = await applied([READ, CREATE_ONLY]);
    world.createdAs = "ACTIVE";
    const first = await live(routine);
    expect(adPosts()).toHaveLength(1);
    const adId = world.ads[0].id;
    expect(itemOf("c1").externalId).toBe(adId);
    expect(first.status).not.toBe("success");

    // The next day the ad bears another name in Meta: looking for it by name finds nothing.
    world.ads[0].name = "Renommée dans le gestionnaire";
    world.createdAs = null;
    const from = world.calls.length;
    const second = await live(routine);
    // The defect: a second ad for the same row.
    expect(adPosts()).toHaveLength(1);
    expect(world.ads).toHaveLength(1);
    const calls = world.calls.slice(from);
    // (c) by the id kept in the database first: THAT ad is read, the ad set is not searched by name.
    expect(calls.filter((c) => c.method === "GET" && c.path === `/${adId}`)).toHaveLength(1);
    expect(calls.filter((c) => c.path === `/${ADSET}/ads`)).toHaveLength(0);
    expect(calls.filter((c) => c.method === "POST" && c.host === "graph.facebook.com")).toEqual([]);
    expect(itemOf("c1")).toMatchObject({ externalId: adId, status: "uncertain" });
    expect(stepOf(second, "creer").warnings.join(" ")).toContain(`la publicité ${adId} existe au statut ACTIVE`);

    // A third run, a fourth: never.
    await live(routine);
    await live(routine);
    expect(adPosts()).toHaveLength(1);
  });

  it("(a) le gabarit du nom contenait la date : même avec une définition enregistrée avant la correction, l'élément qui porte un identifiant n'est pas rejoué", async () => {
    const { claimItem, settleItem, peekItem } = await import("@/lib/routines/store");
    const key = "creer:c1";
    expect(stateOf(await claimItem({ routineId: "r1", runId: "run1", stepId: "creer", itemKey: key, label: "2026-09-29 - Visuel" }))).toBe("claimed");
    await settleItem({ routineId: "r1", itemKey: key, status: "failed", externalId: "90000001", error: "créée mais non confirmée en pause" });
    // Whatever its status, it is never « claimed » again: neither by a live run nor announced by a dry run.
    for (const runId of ["run2", "run3", "run4"]) {
      expect(stateOf(await claimItem({ routineId: "r1", runId, stepId: "creer", itemKey: key, label: "2026-09-30 - Visuel" }))).toBe("uncertain");
    }
    expect(stateOf(await peekItem("r1", key))).toBe("uncertain");
    expect(db.routineItem.rows[0]).toMatchObject({ status: "uncertain", externalId: "90000001", attempts: 1 });

    // An item left `failed` with an id by the code of before is handled the same way.
    await db.routineItem.create({ data: { routineId: "r1", runId: "old", stepId: "creer", itemKey: "creer:c2", status: "failed", externalId: "90000002", attempts: 1 } });
    const again = await claimItem({ routineId: "r1", runId: "run5", stepId: "creer", itemKey: "creer:c2", label: "x" });
    expect(stateOf(again)).toBe("uncertain");
    expect((again as unknown as { externalId?: string }).externalId).toBe("90000002");
    expect(db.routineItem.rows[1]).toMatchObject({ status: "uncertain", externalId: "90000002" });
  });

  it("(a) la publicité relue par son identifiant est en pause : la ligne est close, le Sheet le dit, rien n'est créé", async () => {
    world.sheet = [sheetRow("c1")];
    const routine = await applied([READ, CREATE]);
    world.createdAs = "ACTIVE";
    await live(routine);
    const adId = world.ads[0].id;
    expect(String(statuses()[0])).toMatch(/^à vérifier/);

    // The consultant paused it in the Ads Manager and emptied nothing: the routine reads the ad it knows.
    world.ads[0].status = "PAUSED";
    world.createdAs = null;
    const second = await live(routine);
    expect(adPosts()).toHaveLength(1);
    expect(itemOf("c1")).toMatchObject({ status: "created", externalId: adId });
    expect(world.sheet[0]).toMatchObject({ statut: "déjà présente (en pause)", id_pub: adId });
    expect(stepOf(second, "creer").counts).toMatchObject({ adsCreated: 0, adsAttached: 1 });
  });

  it("(a) la publicité connue a été supprimée dans Meta : « à vérifier », et toujours aucune création", async () => {
    world.sheet = [sheetRow("c1")];
    const routine = await applied([READ, CREATE]);
    world.createdAs = "ACTIVE";
    await live(routine);
    world.gone.add(world.ads[0].id);
    world.createdAs = null;
    await live(routine);
    expect(adPosts()).toHaveLength(1);
    expect(String(statuses()[0])).toMatch(/^à vérifier : la publicité \d+ créée pour cette ligne est introuvable dans Meta$/);
  });

  it("(b) {{run.date}} et {{steps.<id>.text}} sont refusés dans le nom de la publicité, avec la raison", async () => {
    const { validateProposal } = await import("@/lib/routines/validate");
    const named = (adName: string, before: unknown[] = []) =>
      validateProposal(proposal([READ, ...before, { ...CREATE_ONLY, input: "lire", mapping: { ...CREATE.mapping, adName } }]));

    const dated = named("{{run.date}} - {{row.nom}}");
    expect(dated.ok).toBe(false);
    const message = dated.ok ? "" : dated.errors.join(" ");
    expect(message).toContain("mapping.adName");
    expect(message).toContain("{{run.date}}");
    expect(message).toMatch(/ne dépend que de la ligne/);
    expect(message).toMatch(/créée une seconde fois/);

    const quoted = named("{{steps.resume.text}} {{row.nom}}", [{ id: "resume", type: "ai.summary", instruction: "Un nom", onFailure: "fail" }]);
    expect(quoted.ok).toBe(false);
    expect(quoted.ok ? "" : quoted.errors.join(" ")).toContain("{{steps.resume.text}}");

    expect(named("{{row.id}} - {{row.nom}}").ok).toBe(true);
    // The date stays what it was everywhere else: a text, a message.
    expect(validateProposal(proposal([READ, { ...CREATE_ONLY, mapping: { ...CREATE.mapping, primaryText: "Offre du {{run.date}} : {{row.texte}}" } }, SLACK])).ok).toBe(true);

    // The handler refuses it too, for whoever calls it without the validation of the definition.
    const { metaCreateAdsHandler } = await import("@/lib/routines/steps/meta-create-ads");
    const direct = metaCreateAdsHandler.validate({ ...CREATE_ONLY, writeBack: undefined, mapping: { ...CREATE.mapping, adName: "{{row.nom}} {{run.date}}" } });
    expect(direct.ok).toBe(false);
  });

  it("(b) le prompt de l'IA de création le dit", async () => {
    const { buildRoutineComposePrompt } = await import("@/lib/routines/compose-prompt");
    const prompt = buildRoutineComposePrompt({ name: "Créas", clientName: "LPEV", metaAccountId: `act_${ACCOUNT}`, googleCustomerId: null, timezone: "Europe/Paris" });
    expect(prompt).toMatch(/NOM DE LA PUBLICITÉ \(mapping\.adName\) : il ne dépend QUE de la ligne/);
    expect(prompt).toMatch(/N'y mets JAMAIS \{\{run\.date\}\} ni \{\{steps\.<id>\.text\}\}/);
    expect(prompt).toMatch(/"adName":gabarit qui ne lit QUE la ligne/);
  });

  it("une définition enregistrée avec la date dans le nom ne s'exécute plus : elle est refusée avant toute étape", async () => {
    const routine = await applied([READ, CREATE_ONLY]);
    const { hashDefinition } = await import("@/lib/routines/hash");
    const old = { version: 1, steps: [READ, { ...CREATE_ONLY, mapping: { ...CREATE.mapping, adName: "{{run.date}} - {{row.nom}}" } }] };
    const row = db.routine.rows.find((r) => r.id === routine.id)!;
    row.definitionJson = JSON.stringify(old);
    row.definitionHash = hashDefinition({
      definition: old as never, schedule: { kind: "daily", time: "09:00" }, maxItemsPerRun: 20,
      metaAccountId: `act_${ACCOUNT}`, googleCustomerId: null, timezone: "Europe/Paris",
    } as never);
    const result = await live(routine);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/Définition refusée/);
    expect(metaWrites()).toEqual([]);
  });
});

// ── 2. No loop of runs, no message at every firing ───────────────────────

describe("2 — une exécution qui plante n'est pas relancée, et n'envoie pas un message à chaque passage", () => {
  it("base injoignable au moment de clore l'exécution : 4 passages du cron, UN message", async () => {
    const { runLocked } = await import("@/lib/routines/engine");
    const routine = await activated(await applied([SLACK]), NOW);
    const broken = async () => { throw new Error("Can't reach database server"); };
    const { update, updateMany } = db.routineRun;
    db.routineRun.update = broken as typeof update;
    db.routineRun.updateMany = broken as typeof updateMany;
    for (let i = 0; i < 4; i++) {
      const now = new Date(NOW.getTime() + i * 15 * 60_000);
      try { await runLocked(routine.id, { trigger: "schedule", now, deadlineAt: Date.now() + 270_000 }); } catch { /* the first firing crashes */ }
    }
    db.routineRun.update = update;
    db.routineRun.updateMany = updateMany;

    expect(world.slack).toHaveLength(1);
    expect(db.routineRun.rows).toHaveLength(1);
    const after = await reload(routine.id);
    expect(after.lockedUntil).toBeNull();
    expect(after.status).toBe("active");
    // The schedule moved on: tomorrow, 09:00 in Paris.
    expect(after.nextRunAt?.toISOString()).toBe("2026-09-30T07:00:00.000Z");
  });

  it("le planning avance DÈS la prise du verrou, avant toute étape", async () => {
    const { runLocked } = await import("@/lib/routines/engine");
    const routine = await activated(await applied([SLACK]), NOW);
    let seenAtFirstWrite: string | undefined;
    let lockedAtFirstWrite = false;
    world.onSlack = () => {
      const row = db.routine.rows.find((r) => r.id === routine.id)!;
      seenAtFirstWrite = (row.nextRunAt as Date | null)?.toISOString();
      lockedAtFirstWrite = row.lockedUntil !== null;
    };
    await runLocked(routine.id, { trigger: "schedule", now: NOW, deadlineAt: Date.now() + 270_000 });
    expect(world.slack).toHaveLength(1);
    expect(lockedAtFirstWrite).toBe(true);
    expect(seenAtFirstWrite).toBe("2026-09-30T07:00:00.000Z");
  });

  it("exécution restée « running » au-delà du verrou : close comme interrompue au passage suivant, panne d'infrastructure, jamais rejouée", async () => {
    const cron = await import("@/app/api/cron/routines/route");
    const routine = await activated(await applied([READ, CREATE, SLACK]), NOW);
    // The function was killed at 300 s: the run never ended, its lock has expired, its schedule had moved on.
    const started = new Date(Date.now() - 16 * 60_000);
    const row = db.routine.rows.find((r) => r.id === routine.id)!;
    row.nextRunAt = new Date(Date.now() + 20 * 3_600_000);
    row.lockedUntil = new Date(started.getTime() + 330_000);
    const run = await db.routineRun.create({ data: { routineId: routine.id, trigger: "schedule", status: "running", definitionHash: routine.definitionHash, startedAt: started } });
    await db.routineItem.create({ data: { routineId: routine.id, runId: run.id, stepId: "creer", itemKey: `creer:${ADSET}:c1`, status: "pending" } });

    const res = await cron.GET(new NextRequest("http://x/api/cron/routines", { headers: { authorization: "Bearer cron-secret" } }));
    const body = await res.json();
    expect(body).toMatchObject({ interrupted: 1, ran: 0 });

    expect(db.routineRun.rows).toHaveLength(1);
    expect(db.routineRun.rows[0]).toMatchObject({ status: "infra_failed" });
    expect(String(db.routineRun.rows[0].error)).toMatch(/^Exécution interrompue/);
    expect(db.routineRun.rows[0].finishedAt).toBeInstanceOf(Date);
    // What it had reserved is unknown, never created again.
    expect(items()[0]).toMatchObject({ status: "uncertain" });
    // A failure of infrastructure: it is written on the routine, it does not count, it switches nothing off.
    expect(await reload(routine.id)).toMatchObject({ status: "active", lastRunStatus: "infra_failed", consecutiveFailures: 0 });
    expect(world.slack).toEqual([]);
    expect(metaWrites()).toEqual([]);

    // The next firing finds nothing to close and nothing to run.
    const again = await (await cron.GET(new NextRequest("http://x/api/cron/routines", { headers: { authorization: "Bearer cron-secret" } }))).json();
    expect(again).toMatchObject({ interrupted: 0, ran: 0, due: 0 });
    expect(db.routineRun.rows).toHaveLength(1);
  });

  it("trois exécutions interrompues de suite ne sont plus une simple panne : la routine s'arrête, avec UN message dans le canal interne", async () => {
    const { closeInterruptedRuns } = await import("@/lib/routines/engine");
    const routine = await activated(await applied([SLACK]), NOW);
    await db.alertClient.create({ data: { name: "LPEV", accountsJson: JSON.stringify([{ platform: "meta", accountId: ACCOUNT }]), slackChannel: "#interne-lpev" } });
    db.routine.rows.find((r) => r.id === routine.id)!.nextRunAt = new Date(Date.now() + 20 * 3_600_000);
    const day = 86_400_000;
    const now = new Date();

    // One interruption, then two: the routine stays active.
    for (const ago of [2 * day, day]) {
      await db.routineRun.create({ data: { routineId: routine.id, trigger: "schedule", status: "running", definitionHash: routine.definitionHash, startedAt: new Date(now.getTime() - ago) } });
      expect(await closeInterruptedRuns(now)).toMatchObject({ closed: 1, disabled: [] });
      expect((await reload(routine.id)).status).toBe("active");
    }
    expect(world.slack).toEqual([]);

    await db.routineRun.create({ data: { routineId: routine.id, trigger: "schedule", status: "running", definitionHash: routine.definitionHash, startedAt: new Date(now.getTime() - 10 * 60_000) } });
    expect(await closeInterruptedRuns(now)).toMatchObject({ closed: 1, disabled: [routine.id] });
    expect(await reload(routine.id)).toMatchObject({ status: "error", nextRunAt: null, dryRunHash: null });
    expect(world.slack).toHaveLength(1);
    expect(world.slack[0].channel).toBe("#interne-lpev");
    expect(world.slack[0].text).toMatch(/Routine arrêtée automatiquement/);
    expect(world.slack[0].text).toMatch(/3 exécutions interrompues de suite/);
    expect(db.routineEvent.rows.filter((e) => e.kind === "auto_disabled")).toHaveLength(1);
  });

  it("une exécution récente encore en cours n'est pas close : seul le dépassement de la durée du verrou le permet", async () => {
    const { closeInterruptedRuns } = await import("@/lib/routines/engine");
    const routine = await activated(await applied([SLACK]), NOW);
    const now = new Date();
    await db.routineRun.create({ data: { routineId: routine.id, trigger: "manual", status: "running", definitionHash: routine.definitionHash, startedAt: new Date(now.getTime() - 120_000) } });
    expect(await closeInterruptedRuns(now)).toMatchObject({ closed: 0 });
    expect(db.routineRun.rows[0].status).toBe("running");
  });
});

// ── 3. The Sheet never says « en pause » of an ad that is not ─────────────

describe("3 — publicité du même nom déjà présente : le statut réellement lu", () => {
  it("ACTIVE : rien n'est créé ni modifié, la ligne est « à vérifier » avec le statut lu, les autres lignes sont traitées", async () => {
    world.ads.push({ id: "90000777", name: "Visuel c1", status: "ACTIVE", adset_id: ADSET });
    const routine = await applied([READ, CREATE]);
    const result = await live(routine);

    expect(world.sheet[0]).toMatchObject({ statut: "à vérifier : une publicité du même nom existe au statut ACTIVE", id_pub: null });
    expect(String(world.sheet[0].erreur)).toContain("90000777");
    expect(String(world.sheet[0].erreur)).toContain("rien n'a été créé ni modifié");
    expect(statuses().join(" ")).not.toContain("déjà présente");
    // Nothing is sent about that ad: neither a creation nor a pause.
    expect(adPosts().map((c) => c.body?.name)).toEqual(["Visuel c2", "Visuel c3"]);
    expect(posts().filter((c) => c.path === "/90000777")).toEqual([]);
    expect(world.ads.find((a) => a.id === "90000777")!.status).toBe("ACTIVE");
    // It is not attached as one of ours.
    expect(itemOf("c1")).toMatchObject({ status: "failed", externalId: null });
    expect(stepOf(result, "creer").written.map((w) => w.itemKey)).toEqual(["c2", "c3"]);
    expect(statuses().slice(1)).toEqual(["créée (en pause)", "créée (en pause)"]);
    expect(result.status).toBe("partial");
  });

  it("PAUSED : elle est rattachée, et « en pause » est vrai", async () => {
    world.ads.push({ id: "90000777", name: "Visuel c1", status: "PAUSED", adset_id: ADSET });
    const routine = await applied([READ, CREATE]);
    const result = await live(routine);
    expect(world.sheet[0]).toMatchObject({ statut: "déjà présente (en pause)", id_pub: "90000777" });
    expect(itemOf("c1")).toMatchObject({ status: "created", externalId: "90000777" });
    expect(adPosts()).toHaveLength(2);
    expect(result.status).toBe("success");
  });

  it.each(["ARCHIVED", "DELETED", "IN_PROCESS"])("%s : « à vérifier » aussi, jamais « en pause »", async (status) => {
    world.sheet = [sheetRow("c1")];
    world.ads.push({ id: "90000777", name: "Visuel c1", status, adset_id: ADSET });
    await live(await applied([READ, CREATE]));
    expect(world.sheet[0].statut).toBe(`à vérifier : une publicité du même nom existe au statut ${status}`);
    expect(metaWrites()).toEqual([]);
  });

  it("essai à blanc : l'essai dit la même chose, sans rien prévoir pour cette ligne", async () => {
    world.ads.push({ id: "90000777", name: "Visuel c1", status: "ACTIVE", adset_id: ADSET });
    const result = await dry(await applied([READ, CREATE]));
    const step = stepOf(result, "creer");
    expect(step.planned.filter((p) => p.target === "meta").map((p) => p.itemKey)).toEqual(["c2", "c3"]);
    expect(step.output.rows?.rows[0]).toMatchObject({ id: "c1", meta_statut: "à vérifier : une publicité du même nom existe au statut ACTIVE" });
    expect(step.warnings.join(" ")).toMatch(/c1.*au statut ACTIVE \(90000777\)/);
    // A row to look at does not make the definition wrong: the dry run succeeds.
    expect(result.status).toBe("success");
    expect(posts().filter((c) => c.host === "graph.facebook.com" || c.path === "/api/sheets/update")).toEqual([]);
  });
});

// ── 5. A run started at the end of the budget ────────────────────────────

describe("5 — fin du budget de temps", () => {
  it("moins de 90 s avant l'échéance pour une routine qui crée des publicités : elle n'est pas démarrée et reste due", async () => {
    const { runLocked } = await import("@/lib/routines/engine");
    const routine = await activated(await applied([READ, CREATE]), NOW);
    const due = routine.nextRunAt?.toISOString();
    for (const left of [30_000, 89_000]) {
      const ran = await runLocked(routine.id, { trigger: "schedule", now: NOW, deadlineAt: Date.now() + left });
      expect(ran.outcome).toBe("postponed");
    }
    expect(world.calls).toEqual([]);
    expect(db.routineRun.rows).toEqual([]);
    const after = await reload(routine.id);
    expect(after.nextRunAt?.toISOString()).toBe(due);
    expect(after).toMatchObject({ lockedUntil: null, lastRunAt: null, lastRunStatus: null });

    // With the time it needs, the next firing takes it.
    const ran = await runLocked(routine.id, { trigger: "schedule", now: NOW, deadlineAt: Date.now() + 270_000 });
    expect(ran.outcome).toBe("ran");
    expect(adPosts()).toHaveLength(3);
  });

  it("30 s suffisent à une routine qui n'écrit pas sur une plateforme, pas 29", async () => {
    const { runLocked } = await import("@/lib/routines/engine");
    const routine = await activated(await applied([SLACK]), NOW);
    expect((await runLocked(routine.id, { trigger: "schedule", now: NOW, deadlineAt: Date.now() + 29_000 })).outcome).toBe("postponed");
    expect(world.slack).toEqual([]);
    expect((await runLocked(routine.id, { trigger: "schedule", now: NOW, deadlineAt: Date.now() + 31_000 })).outcome).toBe("ran");
    expect(world.slack).toHaveLength(1);
  });

  it("cron : l'échéance est commune au passage ; la routine arrivée en fin de budget reste due, une plus légère passe encore", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const cron = await import("@/app/api/cron/routines/route");
    const first = await activated(await applied([READ, { id: "dire", type: "slack.message", channel: "#c_client", text: "Lu" }]), NOW);
    const ads = await activated(await applied([READ, CREATE]), NOW);
    const light = await activated(await applied([SLACK]), NOW);
    db.routine.rows.find((r) => r.id === first.id)!.nextRunAt = new Date(NOW.getTime() - 3 * 60_000);
    db.routine.rows.find((r) => r.id === ads.id)!.nextRunAt = new Date(NOW.getTime() - 2 * 60_000);
    // The first routine is slow: 200 of the 270 seconds are gone when it ends.
    let slowed = false;
    world.onSheetRead = () => { if (!slowed) { slowed = true; vi.setSystemTime(new Date(NOW.getTime() + 200_000)); } };

    const body = await (await cron.GET(new NextRequest("http://x/api/cron/routines", { headers: { authorization: "Bearer cron-secret" } }))).json();
    expect(body).toMatchObject({ due: 3, ran: 2, deferred: 1, timedOut: true });
    expect(body.runs.map((r: { routineId: string; outcome: string }) => [r.routineId, r.outcome])).toEqual([[first.id, "ran"], [ads.id, "postponed"], [light.id, "ran"]]);

    expect(metaWrites()).toEqual([]);
    expect(db.routineRun.rows.map((r) => r.routineId)).toEqual([first.id, light.id]);
    const waiting = await reload(ads.id);
    expect(waiting.nextRunAt?.getTime()).toBe(NOW.getTime() - 2 * 60_000);
    expect(waiting).toMatchObject({ lockedUntil: null, lastRunStatus: null });
  });

  it("l'étape qui s'arrête faute de temps le dit : exécution « partial », timedOut vrai, le reste à l'exécution suivante", async () => {
    const routine = await applied([READ, CREATE]);
    // 50 s: enough to start the step, not enough to start an ad (60 s each).
    const result = await live(routine, { deadlineAt: Date.now() + 50_000 });
    const step = stepOf(result, "creer");
    expect(adPosts()).toHaveLength(0);
    expect(step.timedOut).toBe(true);
    expect(step.counts).toMatchObject({ adsCreated: 0, deferred: 3 });
    expect(result).toMatchObject({ status: "partial", timedOut: true, deferred: 3 });
    expect(items()).toEqual([]);
    expect(statuses()).toEqual([null, null, null]);
    // Running out of time is nobody's fault, and the stored run says what happened.
    expect(db.routineRun.rows[0]).toMatchObject({ status: "partial" });
    expect(JSON.parse(String(db.routineRun.rows[0].stepsJson))[1]).toMatchObject({ timedOut: true, counts: { deferred: 3 } });

    const next = await live(routine);
    expect(adPosts()).toHaveLength(3);
    expect(next).toMatchObject({ status: "success", timedOut: false, deferred: 0 });
  });

  it("`deferred` compte les lignes que l'étape laisse d'elle-même au plafond, et seulement celles qui attendent", async () => {
    world.sheet = ["c1", "c2", "c3", "c4", "c5"].map((id) => sheetRow(id));
    const routine = await applied([READ, CREATE_ONLY], { maxItemsPerRun: 2 });
    const first = await live(routine);
    expect(adPosts()).toHaveLength(2);
    expect(first).toMatchObject({ status: "success", timedOut: false, deferred: 3 });
    expect(stepOf(first, "creer").counts).toMatchObject({ adsCreated: 2, deferred: 3, skipped: 0 });

    // No filter, no status in the Sheet: the rows come back. Those done are skipped, not said to wait.
    const second = await live(routine);
    expect(second).toMatchObject({ deferred: 1 });
    expect(stepOf(second, "creer").counts).toMatchObject({ adsCreated: 2, skipped: 2, deferred: 1 });
    const third = await live(routine);
    expect(third).toMatchObject({ deferred: 0 });
    expect(stepOf(third, "creer").counts).toMatchObject({ adsCreated: 1, skipped: 4, deferred: 0 });
    expect(world.ads).toHaveLength(5);
  });
});

// ── 6. Counters by nature of write ───────────────────────────────────────

describe("6 — compteurs de l'historique, par nature d'écriture", () => {
  it("exécution réelle : publicités créées, rattachées, lignes de Sheet et messages ne sont plus additionnés sous un seul nom", async () => {
    world.ads.push({ id: "90000777", name: "Visuel c1", status: "PAUSED", adset_id: ADSET });
    const routine = await applied([READ, CREATE, SLACK]);
    const result = await live(routine) as unknown as { counts: Record<string, number>; totals: Record<string, number>; steps: Array<{ planned: unknown[] }> };
    expect(adPosts()).toHaveLength(2);
    expect(result.counts).toEqual({ adsCreated: 2, adsAttached: 1, sheetRows: 3, messages: 1, skipped: 0, failed: 0, deferred: 0 });
    // The columns of the run keep the total, and « planned » belongs to the dry run.
    expect(result.totals).toEqual({ planned: 0, created: 7, skipped: 0, failed: 0 });
    expect(result.steps.every((s) => s.planned.length === 0)).toBe(true);
    expect(db.routineRun.rows[0]).toMatchObject({ itemsPlanned: 0, itemsCreated: 7, itemsSkipped: 0, itemsFailed: 0 });
  });

  it("essai à blanc : les mêmes compteurs, la même lecture", async () => {
    world.ads.push({ id: "90000777", name: "Visuel c1", status: "PAUSED", adset_id: ADSET });
    const routine = await applied([READ, CREATE, SLACK]);
    const tried = await dry(routine) as unknown as { counts: Record<string, number>; totals: Record<string, number> };
    expect(tried.counts).toEqual({ adsCreated: 2, adsAttached: 1, sheetRows: 3, messages: 1, skipped: 0, failed: 0, deferred: 0 });
    expect(tried.totals).toEqual({ planned: 7, created: 0, skipped: 0, failed: 0 });
    const done = await live(routine) as unknown as { counts: Record<string, number> };
    expect(done.counts).toEqual(tried.counts);
  });

  it("l'historique les lit dans stepsJson et les affiche tels quels", async () => {
    world.ads.push({ id: "90000777", name: "Visuel c1", status: "PAUSED", adset_id: ADSET });
    world.refused.add("Visuel c3");
    const routine = await applied([READ, CREATE, SLACK]);
    await dry(routine);
    await live(routine);
    const { runView } = await import("@/lib/routines/store");
    const { runCounters, toRunView } = await import("@/components/routines/routine-model");
    const [tried, ran] = db.routineRun.rows.map((r) => toRunView(JSON.parse(JSON.stringify(runView(r as never))))!);

    expect(JSON.parse(String(db.routineRun.rows[1].stepsJson)).map((s: { counts: unknown }) => s.counts)).toEqual([
      { adsCreated: 0, adsAttached: 0, sheetRows: 0, messages: 0, skipped: 0, failed: 0, deferred: 0 },
      { adsCreated: 1, adsAttached: 1, sheetRows: 3, messages: 0, skipped: 0, failed: 1, deferred: 0 },
      { adsCreated: 0, adsAttached: 0, sheetRows: 0, messages: 0, skipped: 0, failed: 0, deferred: 0 },
    ]);
    expect(ran.counts).toEqual({ adsCreated: 1, adsAttached: 1, sheetRows: 3, messages: 0, skipped: 0, failed: 1, deferred: 0 });
    expect(runCounters(ran).map((c) => c.text)).toEqual(["1 publicité créée", "1 publicité rattachée", "3 lignes écrites dans un Sheet", "1 en échec"]);
    expect(runCounters(tried).map((c) => c.text)).toEqual(["2 publicités à créer", "1 publicité à rattacher", "3 lignes de Sheet à écrire", "1 message à envoyer"]);
  });
});

// ── 9, 12. Messages ──────────────────────────────────────────────────────

describe("9 — lien Slack déguisé venu d'une cellule", () => {
  it("il arrive dans le canal en clair, plus jamais cliquable sous un faux texte", async () => {
    world.sheet = [sheetRow("c1", { nom: "Bravo <https://evil.example/login|Valider le budget> <!channel>" })];
    const routine = await applied([READ, { id: "dire", type: "slack.message", channel: "#c_client", text: "Nouvelle créa : {{row.nom}}" }]);
    await live(routine);
    expect(world.slack).toHaveLength(1);
    const text = world.slack[0].text;
    expect(text).toContain("Valider le budget (https://evil.example/login)");
    expect(text).not.toMatch(/<https?:[^>]*\|/);
    expect(text).not.toContain("<!channel>");
  });

  it("dans le tableau joint au message aussi", async () => {
    world.sheet = [sheetRow("c1", { nom: "<https://evil.example|Clic>" })];
    const routine = await applied([READ, { id: "g", type: "rows.select", columns: [{ from: "id" }, { from: "nom" }] }, { ...SLACK, includeTable: true }]);
    await live(routine);
    expect(world.slack[0].text).not.toMatch(/<https?:[^>]*\|/);
    expect(world.slack[0].text).toContain("https://evil.example");
  });
});

describe("12 — webhook sans secret", () => {
  it("Slack : refus à l'application de la définition et à l'exécution, rien n'est envoyé", async () => {
    const routine = await applied([SLACK]);
    vi.stubEnv("N8N_ALERT_WEBHOOK_SECRET", "");
    const { slackMessageHandler } = await import("@/lib/routines/steps/slack-message");
    const issues = await slackMessageHandler.preflight(SLACK as never, { id: "r", name: "n", metaAccountId: null, googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error" });
    expect(issues[0].message).toMatch(/secret du webhook n8n n'est pas configuré/);

    const result = await live(routine);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/secret du webhook n8n n'est pas configuré/);
    expect(stepOf(result, "prevenir").error).toMatchObject({ class: "functional" });
    expect(world.calls).toEqual([]);
  });

  it("e-mail : pareil, et le secret part toujours dans l'en-tête quand il existe", async () => {
    vi.stubEnv("N8N_ROUTINES_WEBHOOK_URL", "https://n8n.example.org/webhook/routines");
    const { emailSendHandler } = await import("@/lib/routines/steps/email-send");
    const { routinesWebhook, sendEmail } = await import("@/lib/routines/notify");
    const step = { id: "mail", type: "email.send", to: ["lea@impulse-analytics.com"], subject: "Bilan", body: "Bonjour" } as never;
    const target = { id: "r", name: "n", metaAccountId: null, googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20 };
    expect(await emailSendHandler.preflight(step, target)).toEqual([]);

    vi.stubEnv("N8N_ALERT_WEBHOOK_SECRET", "");
    vi.stubEnv("N8N_ROUTINES_WEBHOOK_SECRET", "");
    expect(routinesWebhook()?.secret).toBe("");
    const issues = await emailSendHandler.preflight(step, target);
    expect(issues.map((i) => i.severity)).toEqual(["error"]);
    expect(issues[0].message).toMatch(/secret du webhook n8n n'est pas configuré/);

    // Even with the guard of a live run in hand, the sender refuses before any call.
    const { mintWriteGuard } = await import("@/lib/routines/write-guard");
    await expect(sendEmail(mintWriteGuard("live", "run-x"), { to: ["lea@impulse-analytics.com"], subject: "s", text: "t" })).rejects.toThrow(/secret du webhook n8n n'est pas configuré/);
    expect(world.calls).toEqual([]);
  });

  it("avec le secret, le message part et le porte dans son en-tête", async () => {
    const seen: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (t: string | URL | Request, i?: RequestInit) => {
      if (String(t) === N8N) seen.push(new Headers(i?.headers).get("x-alert-secret"));
      return router(t, i);
    }));
    await live(await applied([SLACK]));
    expect(world.slack).toHaveLength(1);
    expect(seen).toEqual(["n8n-secret-value"]);
  });
});

// ── 10. One rule for the account ids ─────────────────────────────────────

describe("10 — identifiants de compte : une seule règle, partagée", () => {
  const META = ["act_564381881705822", "564381881705822", "act_12345678", "act_123", "123", "act_1234567", "act_12; DROP", "https://x", "", "act_", "act_12345678901234567890123"];
  const GOOGLE = ["4768893847", "476-889-3847", "12345-6", "123456", "47688938", "476889384712", "476-8893847", "abc", ""];

  it("ce que la création de la routine accepte, le module Meta et l'étape Google l'acceptent, et inversement", async () => {
    const { isMetaAccountId, isGoogleCustomerId } = await import("@/lib/routines/accounts");
    const { pausedAdInputError } = await import("@/lib/meta-write");
    const { cleanCustomerId } = await import("@/lib/routines/steps/google-insights");
    const ad = { campaignId: CAMPAIGN, adsetId: ADSET, pageId: PAGE, name: "n", primaryText: "t", linkUrl: "https://a.example.org", imageUrl: "https://a.example.org/i.jpg" };

    expect(META.filter((id) => isMetaAccountId(id))).toEqual(["act_564381881705822", "564381881705822", "act_12345678"]);
    for (const id of META) expect(pausedAdInputError({ accountId: id, ...ad }) === null, `Meta ${id}`).toBe(isMetaAccountId(id));
    expect(GOOGLE.filter((id) => isGoogleCustomerId(id))).toEqual(["4768893847", "476-889-3847"]);
    for (const id of GOOGLE) expect(cleanCustomerId(id) !== null, `Google ${id}`).toBe(isGoogleCustomerId(id));
    expect(cleanCustomerId("476-889-3847")).toBe("4768893847");
  });

  it("le module Meta refuse l'ensemble d'un compte dont l'identifiant n'en est pas un, sans rien lire", async () => {
    const { verifyAdsetInAccount } = await import("@/lib/meta-write");
    await expect(verifyAdsetInAccount("act_123", CAMPAIGN, ADSET)).rejects.toThrow(/Compte publicitaire invalide/);
    await expect(verifyAdsetInAccount("act_12345", CAMPAIGN, ADSET)).rejects.toThrow(/Compte publicitaire invalide/);
    expect(world.calls).toEqual([]);
  });
});

// ── 11. An item given up is not « already done » ─────────────────────────

describe("11 — élément échoué 3 fois", () => {
  it("il est « abandonné après 3 tentatives », avec sa dernière erreur, dans le Sheet et dans l'historique", async () => {
    world.sheet = [sheetRow("c1"), sheetRow("c2")];
    world.refused.add("Visuel c2");
    const routine = await applied([READ, CREATE]);
    const attempts = () => adPosts().filter((c) => c.body?.name === "Visuel c2").length;

    await live(routine);
    expect(world.sheet[1].statut).toBe("échec");
    await live(routine);
    expect(attempts()).toBe(2);
    const third = await live(routine);
    expect(attempts()).toBe(3);
    // At the third failure the Sheet says it at once, with the error Meta gave.
    expect(world.sheet[1].statut).toBe("abandonnée après 3 tentatives");
    expect(String(world.sheet[1].erreur)).toMatch(/refusée par Meta.*Invalid parameter/);
    expect(stepOf(third, "creer").warnings.join(" ")).toMatch(/c2 » abandonnée après 3 tentatives : .*refusée par Meta/);
    expect(stepOf(third, "creer").output.rows?.rows.map((r) => [r.id, r.meta_statut])).toEqual([["c2", "abandonnée après 3 tentatives"]]);

    // Later runs: nothing is sent for it, and it is never shown as « déjà traitée ».
    world.sheet[1].statut = null;
    world.sheet[1].erreur = null;
    const fourth = await live(routine);
    expect(attempts()).toBe(3);
    expect(world.sheet[1].statut).toBe("abandonnée après 3 tentatives");
    expect(String(world.sheet[1].erreur)).toMatch(/refusée par Meta/);
    expect(JSON.stringify(fourth.steps)).not.toContain("déjà traitée");
    expect(stepOf(fourth, "creer").warnings.join(" ")).toMatch(/c2 » abandonnée après 3 tentatives : .*refusée par Meta/);

    const { runView } = await import("@/lib/routines/store");
    const { toRunView } = await import("@/components/routines/routine-model");
    const shown = toRunView(JSON.parse(JSON.stringify(runView(db.routineRun.rows.at(-1) as never))))!;
    expect(shown.steps.find((s) => s.stepId === "creer")!.warnings.join(" ")).toMatch(/abandonnée après 3 tentatives : .*refusée par Meta/);

    // The dry run says the same, and plans nothing for it.
    const tried = await dry(routine);
    expect(stepOf(tried, "creer").planned.filter((p) => p.target === "meta")).toEqual([]);
    expect(stepOf(tried, "creer").warnings.join(" ")).toMatch(/abandonnée après 3 tentatives/);
  });
});

// ── 13. The account is the routine's ─────────────────────────────────────

describe("13 — le compte Meta est celui de la routine, jamais celui de l'étape", () => {
  it("une étape qui porterait un compte n'est pas écoutée : tout part sur le compte de la routine", async () => {
    const { metaCreateAdsHandler } = await import("@/lib/routines/steps/meta-create-ads");
    const routine = await applied([READ, CREATE_ONLY]);
    const stored = JSON.parse(routine.definitionJson).steps[1];
    // What the validation would refuse, handed straight to the step: an account of its own, under every name.
    const hostile = { ...stored, accountId: `act_${OTHER_ACCOUNT}`, metaAccountId: `act_${OTHER_ACCOUNT}`, account_id: OTHER_ACCOUNT, account: OTHER_ACCOUNT };
    expect(metaCreateAdsHandler.validate(hostile).ok).toBe(false);

    const { mintWriteGuard } = await import("@/lib/routines/write-guard");
    const claimed: string[] = [];
    const out = await metaCreateAdsHandler.run(hostile, {
      mode: "live",
      routine: { id: routine.id, name: "x", metaAccountId: `act_${ACCOUNT}`, googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20 },
      runId: "run1", now: NOW, deadlineAt: Date.now() + 250_000,
      input: { columns: COLUMNS, rows: [sheetRow("c1")] as never, truncated: false },
      outputs: {}, write: mintWriteGuard("live", "run1"),
      claimItem: (async (_s: string, key: string) => { claimed.push(key); return { state: "claimed", attempts: 1 }; }) as never,
      settleItem: async () => {},
    });
    expect(out.status).toBe("ok");
    expect(metaWrites().map((c) => c.path)).toEqual([`/act_${ACCOUNT}/adcreatives`, `/act_${ACCOUNT}/ads`]);
    expect(world.calls.some((c) => c.url.includes(OTHER_ACCOUNT) || JSON.stringify(c.body ?? {}).includes(OTHER_ACCOUNT))).toBe(false);
    expect(out.written).toHaveLength(1);
  });

  it("sans compte sur la routine, le compte de l'étape ne sert pas de repli : rien n'est lu, rien n'est écrit", async () => {
    const { metaCreateAdsHandler } = await import("@/lib/routines/steps/meta-create-ads");
    const routine = await applied([READ, CREATE_ONLY]);
    const stored = JSON.parse(routine.definitionJson).steps[1];
    const out = await metaCreateAdsHandler.run({ ...stored, accountId: `act_${ACCOUNT}`, metaAccountId: `act_${ACCOUNT}` }, {
      mode: "dry_run",
      routine: { id: routine.id, name: "x", metaAccountId: null, googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20 },
      runId: "run1", now: NOW, deadlineAt: Date.now() + 250_000,
      input: { columns: COLUMNS, rows: [sheetRow("c1")] as never, truncated: false },
      outputs: {}, write: null,
      claimItem: (async () => ({ state: "claimed", attempts: 1 })) as never,
      settleItem: async () => {},
    });
    expect(out).toMatchObject({ status: "failed", planned: [], error: { class: "functional" } });
    expect(out.error?.message).toMatch(/Aucun compte Meta n'est rattaché à la routine/);
    expect(world.calls).toEqual([]);
  });

  it("le compte de la routine a changé en base : l'exécution est refusée avant toute étape (empreinte)", async () => {
    const routine = await applied([READ, CREATE_ONLY]);
    db.routine.rows.find((r) => r.id === routine.id)!.metaAccountId = `act_${OTHER_ACCOUNT}`;
    const result = await live(routine);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/empreinte/);
    expect(world.calls).toEqual([]);
  });
});

// ── 14. What the engine tests said of a stand-in, said of the real step ──

describe("14 — la vraie étape, avec le vrai moteur", () => {
  it("une publicité rattachée n'est pas une création : elle ne fait pas dépasser le plafond", async () => {
    world.sheet = ["c1", "c2", "c3"].map((id) => sheetRow(id));
    const routine = await applied([READ, CREATE_ONLY], { maxItemsPerRun: 2 });
    // c1: created by an earlier run, not confirmed paused then, paused since. Read again by its id, on top of two creations.
    world.ads.push({ id: "90000555", name: "Visuel c1", status: "PAUSED", adset_id: ADSET });
    await db.routineItem.create({ data: { routineId: routine.id, runId: "old", stepId: "creer", itemKey: `creer:${ADSET}:c1`, status: "uncertain", externalId: "90000555" } });
    const result = await live(routine);
    expect(result.status).toBe("success");
    expect(stepOf(result, "creer").counts).toMatchObject({ adsCreated: 2, adsAttached: 1, deferred: 0 });
    expect(adPosts().map((c) => c.body?.name)).toEqual(["Visuel c2", "Visuel c3"]);
    expect(itemOf("c1")).toMatchObject({ status: "created", externalId: "90000555" });
  });

  it("essai à blanc : ce qui est créé ou inconnu en base n'est pas annoncé, et rien n'est réservé", async () => {
    const routine = await applied([READ, CREATE_ONLY]);
    await live(routine);
    expect(world.ads).toHaveLength(3);
    // c2 is unknown (its run never settled it); Meta no longer lists the ad of c1 (archived): the database answers.
    const c2 = itemOf("c2");
    c2.status = "uncertain";
    c2.externalId = null;
    world.ads.splice(0, 2);
    world.sheet.push(sheetRow("c4"));
    db.routineItem.writes.length = 0;
    const from = world.calls.length;

    const tried = await dry(routine);
    const step = stepOf(tried, "creer");
    expect(step.planned.map((p) => p.itemKey)).toEqual(["c4"]);
    expect(step.output.rows?.rows.map((r) => [r.id, r.meta_statut])).toEqual([["c4", "prévue"]]);
    expect(step.counts).toMatchObject({ adsCreated: 1, skipped: 3, deferred: 0 });
    expect(step.warnings.join(" ")).toMatch(/c2.*à vérifier/);
    expect(db.routineItem.writes).toEqual([]);
    expect(items()).toHaveLength(3);
    expect(world.calls.slice(from).filter((c) => c.method !== "GET" && c.host === "graph.facebook.com")).toEqual([]);

    // And the live run does what the dry run said.
    await live(routine);
    expect(adPosts().map((c) => c.body?.name)).toEqual(["Visuel c1", "Visuel c2", "Visuel c3", "Visuel c4"]);
  });

  it("plafond : les lignes reportées ne sont ni réservées, ni dites « déjà traitées », ni écrites dans le Sheet", async () => {
    world.sheet = ["c1", "c2", "c3", "c4"].map((id) => sheetRow(id));
    const routine = await applied([READ, CREATE], { maxItemsPerRun: 2 });
    const result = await live(routine);
    expect(adPosts()).toHaveLength(2);
    expect(items().map((i) => i.status)).toEqual(["created", "created"]);
    expect(statuses()).toEqual(["créée (en pause)", "créée (en pause)", null, null]);
    expect(JSON.stringify(result.steps)).not.toContain("déjà traitée");
    expect(stepOf(result, "creer").output.rows?.rows.map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(result.deferred).toBe(2);
  });

  it("le code mort a disparu du magasin", async () => {
    const store = await import("@/lib/routines/store") as Record<string, unknown>;
    for (const name of ["wasDeferred", "itemKeyFor", "settledItemKeys", "noteDeferred", "forgetDeferred"]) expect(store[name], name).toBeUndefined();
  });
});

// ── Decisions of the lead developer ──────────────────────────────────────

describe("A — refus de Meta sur une ligne", () => {
  it("les autres lignes sont traitées, l'exécution est « partial » et ne compte pas vers l'arrêt automatique", async () => {
    world.refused.add("Visuel c2");
    const routine = await activated(await applied([READ, NEW_ROWS, CREATE, SLACK]), NOW);
    db.routine.rows.find((r) => r.id === routine.id)!.consecutiveFailures = 2;
    const result = await live(routine);
    expect(world.ads.map((a) => a.name)).toEqual(["Visuel c1", "Visuel c3"]);
    expect(result).toMatchObject({ status: "partial", autoDisabled: false });
    expect(stepOf(result, "creer").error).toMatchObject({ scope: "items" });
    // Two functional failures before it: a partial run is not the third.
    expect(await reload(routine.id)).toMatchObject({ status: "active", consecutiveFailures: 2, lastRunStatus: "partial" });
    expect(db.routineEvent.rows.filter((e) => e.kind === "auto_disabled")).toEqual([]);
  });

  it("la ligne refusée est retentée 3 fois puis abandonnée, et n'arrête jamais la routine à elle seule", async () => {
    world.sheet = [sheetRow("c1")];
    world.refused.add("Visuel c1");
    const routine = await activated(await applied([READ, CREATE_ONLY]), NOW);
    for (let i = 1; i <= 5; i++) {
      const result = await live(routine);
      expect(result.autoDisabled, `exécution ${i}`).toBe(false);
      expect(await reload(routine.id), `exécution ${i}`).toMatchObject({ status: "active", consecutiveFailures: 0 });
    }
    // Three attempts, not five: the fourth and fifth runs send nothing for it.
    expect(adPosts()).toHaveLength(3);
    expect(world.ads).toEqual([]);
    expect(itemOf("c1")).toMatchObject({ status: "failed", attempts: 3 });
    expect(world.slack).toEqual([]);
  });

  it("une exécution entièrement en échec compte : à la troisième la routine s'arrête, avec UN message", async () => {
    await db.alertClient.create({ data: { name: "LPEV", accountsJson: JSON.stringify([{ platform: "meta", accountId: ACCOUNT }]), slackChannel: "#interne-lpev" } });
    const routine = await activated(await applied([READ, CREATE, SLACK]), NOW);
    // The column the routine reads was renamed in the Sheet.
    world.sheetColumns = COLUMNS.map((c) => (c === "texte" ? "texte_principal" : c));
    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push(await live(routine));
    expect(outcomes.map((o) => [o.status, o.consecutiveFailures, o.autoDisabled])).toEqual([["failed", 1, false], ["failed", 2, false], ["failed", 3, true]]);
    expect(await reload(routine.id)).toMatchObject({ status: "error", nextRunAt: null });
    expect(metaWrites()).toEqual([]);
    expect(world.slack.map((m) => m.channel)).toEqual(["#interne-lpev"]);
  });
});

describe("B — la clé d'un élément distingue l'étape et l'ensemble de publicités", () => {
  it("changer d'ensemble ne fait pas passer les anciennes clés pour « déjà traitées »", async () => {
    const routine = await applied([READ, CREATE_ONLY]);
    await live(routine);
    expect(world.ads.map((a) => a.adset_id)).toEqual([ADSET, ADSET, ADSET]);
    expect(items().map((i) => i.itemKey)).toEqual([`creer:${ADSET}:c1`, `creer:${ADSET}:c2`, `creer:${ADSET}:c3`]);

    // The consultant sends the same Sheet to another ad set.
    await applied([READ, { ...CREATE_ONLY, adsetId: ADSET_2 }], {}, routine.id);
    const tried = await dry(routine);
    expect(stepOf(tried, "creer").planned.map((p) => p.itemKey)).toEqual(["c1", "c2", "c3"]);
    const result = await live(routine);
    expect(result.status).toBe("success");
    expect(world.ads.map((a) => a.adset_id)).toEqual([ADSET, ADSET, ADSET, ADSET_2, ADSET_2, ADSET_2]);
    expect(items()).toHaveLength(6);
    expect(new Set(items().map((i) => i.itemKey)).size).toBe(6);
    expect(items().slice(3).map((i) => i.itemKey)).toEqual([`creer:${ADSET_2}:c1`, `creer:${ADSET_2}:c2`, `creer:${ADSET_2}:c3`]);

    // Back to the first ad set: its rows are done, nothing is created again.
    await applied([READ, CREATE_ONLY], {}, routine.id);
    await live(routine);
    expect(world.ads).toHaveLength(6);
  });

  it("la clé lue par le consultant reste la valeur de sa colonne", async () => {
    const result = await live(await applied([READ, CREATE_ONLY]));
    expect(stepOf(result, "creer").written.map((w) => w.itemKey)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("C — essai à blanc qui ne prévoit aucune écriture", () => {
  it("routine qui crée des publicités, Sheet vide : l'essai réussit et avertit nettement", async () => {
    world.sheet = [];
    const routine = await applied([READ, CREATE, SLACK]);
    const tried = await dry(routine) as unknown as { status: string; warnings: string[]; counts: Record<string, number> };
    expect(tried.status).toBe("success");
    expect(tried.warnings).toEqual(["L'essai n'a rien trouvé à créer : vous activez sans avoir vu d'exemple."]);

    const { emptyDryRunWarning, toRunView } = await import("@/components/routines/routine-model");
    const { runView } = await import("@/lib/routines/store");
    const shown = toRunView(JSON.parse(JSON.stringify(runView(db.routineRun.rows[0] as never))))!;
    expect(emptyDryRunWarning(shown, { writesPlatform: true })).toBe("L'essai n'a rien trouvé à créer : vous activez sans avoir vu d'exemple.");
  });

  it("l'avertissement ne part pas quand l'essai montre une publicité, ni pour une routine qui n'en crée pas", async () => {
    const withAds = await dry(await applied([READ, CREATE])) as unknown as { warnings: string[] };
    expect(withAds.warnings).toEqual([]);
    world.sheet = [];
    const none = await dry(await applied([READ, { id: "dire", type: "slack.message", channel: "#c_client", text: "Lu" }])) as unknown as { warnings: string[] };
    expect(none.warnings).toEqual([]);
    const { emptyDryRunWarning, toRunView } = await import("@/components/routines/routine-model");
    const { runView } = await import("@/lib/routines/store");
    const [first, second] = db.routineRun.rows.map((r) => toRunView(JSON.parse(JSON.stringify(runView(r as never))))!);
    expect(emptyDryRunWarning(first, { writesPlatform: true })).toBeNull();
    expect(emptyDryRunWarning(second, { writesPlatform: false })).toBeNull();
  });
});

describe("D — pas de bruit dans Slack", () => {
  it("exécution partielle : aucun message dans le canal du client, l'information est dans le Sheet et l'historique", async () => {
    world.refused.add("Visuel c2");
    const result = await live(await applied([READ, CREATE, { id: "bilan", type: "rows.select", columns: [{ from: "id" }, { from: "meta_statut" }] }, { ...SLACK, includeTable: true }]));
    expect(result.status).toBe("partial");
    expect(world.slack).toEqual([]);
    expect(stepOf(result, "prevenir").status).toBe("skipped");
    expect(statuses()).toEqual(["créée (en pause)", "échec", "créée (en pause)"]);
    expect(db.routineRun.rows[0]).toMatchObject({ status: "partial" });
    expect(String(db.routineRun.rows[0].error)).toMatch(/en échec/);
  });

  it("exécution en échec : aucun message non plus, tant que la routine ne s'arrête pas", async () => {
    await db.alertClient.create({ data: { name: "LPEV", accountsJson: JSON.stringify([{ platform: "meta", accountId: ACCOUNT }]), slackChannel: "#interne-lpev" } });
    const routine = await activated(await applied([READ, CREATE, SLACK]), NOW);
    world.sheetColumns = ["id"];
    await live(routine);
    await live(routine);
    expect((await reload(routine.id)).consecutiveFailures).toBe(2);
    expect(world.slack).toEqual([]);
  });
});
