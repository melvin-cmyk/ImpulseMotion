/**
 * Routines — the launch lock (ROUTINES_ACCESS).
 *
 * Closed by default: until the owner has done the acceptance test in real
 * writing, no consultant may create or activate a routine on the account of a
 * client. The REAL routes, every one of them, with the step handlers
 * replaced; the session is the only thing a case decides.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
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
vi.mock("@/lib/relay-chat", async (original) => ({
  ...(await original<typeof import("@/lib/relay-chat")>()),
  relayStream: async () => new Response("data: {\"type\":\"done\"}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
}));

import { db, resetDb, resetSteps, seen, slackStep } from "./routines-engine-fakes";

const CONSULTANT: Session = { userId: "u-lea", role: "admin", baseRole: "consultant", user: { email: "lea@impulse.test" } };
/** A consultant as the session carried them before consultants had every staff capability. */
const PLAIN_CONSULTANT: Session = { userId: "u-sam", role: "consultant", baseRole: "consultant", user: { email: "sam@impulse.test" } };
const ADMIN: Session = { userId: "u-admin", role: "admin", baseRole: "admin", user: { email: "chef@impulse.test" } };
const CLIENT: Session = { userId: "u-client", role: "client", baseRole: "client", user: { email: "client@exemple.fr" } };

const ACCOUNT = "act_564381881705822";
const ROOT = path.resolve(__dirname, "../..");
const at = (id: string, itemId = "citem0000001") => ({ params: Promise.resolve({ id, itemId }) });
const post = (body?: unknown) => new NextRequest("http://x/api/routines", body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) });
const get = (url = "http://x/api/routines") => new NextRequest(url);
const proposal = { name: "Bilan", description: "d", schedule: { kind: "daily", time: "09:00" }, definition: { version: 1, steps: [slackStep] }, explanation: "e", assumptions: [] };

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string; itemId: string }> }) => Promise<Response | undefined>;
interface Call { name: string; file: string; call: (id: string) => Promise<Response | undefined> }

/** Every handler of every route file of the feature. `file` is what the walk of the folder is compared with. */
async function everyCall(): Promise<Call[]> {
  const load = async (file: string) => (await import(`@/app/api/routines/${file}`)) as Record<string, Handler>;
  const list = await load("route"), one = await load("[id]/route");
  const definition = await load("[id]/definition/route"), dryRun = await load("[id]/dry-run/route");
  const activate = await load("[id]/activate/route"), run = await load("[id]/run/route"), runs = await load("[id]/runs/route");
  const assistant = await load("[id]/assistant/route"), items = await load("[id]/items/route"), item = await load("[id]/items/[itemId]/route");
  const pages = await load("pages/route");
  return [
    { name: "GET /routines", file: "route.ts", call: () => list.GET(get(), at("")) },
    { name: "POST /routines", file: "route.ts", call: () => list.POST(post({ name: "Nouvelle", metaAccountId: ACCOUNT }), at("")) },
    { name: "GET /routines/[id]", file: "[id]/route.ts", call: (id) => one.GET(get(), at(id)) },
    { name: "PATCH /routines/[id]", file: "[id]/route.ts", call: (id) => one.PATCH(post({ name: "Renommée" }), at(id)) },
    { name: "DELETE /routines/[id]", file: "[id]/route.ts", call: (id) => one.DELETE(get(), at(id)) },
    { name: "POST definition", file: "[id]/definition/route.ts", call: (id) => definition.POST(post(proposal), at(id)) },
    { name: "POST dry-run", file: "[id]/dry-run/route.ts", call: (id) => dryRun.POST(post(), at(id)) },
    { name: "POST activate", file: "[id]/activate/route.ts", call: (id) => activate.POST(post(), at(id)) },
    { name: "POST run", file: "[id]/run/route.ts", call: (id) => run.POST(post(), at(id)) },
    { name: "GET runs", file: "[id]/runs/route.ts", call: (id) => runs.GET(get(), at(id)) },
    { name: "GET assistant", file: "[id]/assistant/route.ts", call: (id) => assistant.GET(get(), at(id)) },
    { name: "PUT assistant", file: "[id]/assistant/route.ts", call: (id) => assistant.PUT(new NextRequest("http://x", { method: "PUT", body: JSON.stringify({ messages: [], proposals: {} }) }), at(id)) },
    { name: "POST assistant", file: "[id]/assistant/route.ts", call: (id) => assistant.POST(post({ messages: [{ role: "user", content: "Bonjour" }] }), at(id)) },
    { name: "GET items", file: "[id]/items/route.ts", call: (id) => items.GET(get(), at(id)) },
    { name: "POST items/[itemId]", file: "[id]/items/[itemId]/route.ts", call: (id) => item.POST(post({ outcome: "retry" }), at(id)) },
    { name: "GET pages", file: "pages/route.ts", call: () => pages.GET(get(`http://x/api/routines/pages?metaAccountId=${ACCOUNT}`), at("")) },
  ];
}

/** Every route file under app/api/routines, relative to it. */
function routeFiles(): string[] {
  const base = path.join(ROOT, "app/api/routines");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/^route\.(ts|tsx|js|mjs)$/.test(name)) out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  };
  walk(base);
  return out.sort();
}

/** A routine that exists, applied and active, made directly in the database: the lock is what is tested. */
async function seed(): Promise<string> {
  const { applyDefinition, createRoutine, setStatus } = await import("@/lib/routines/store");
  const { validateProposal } = await import("@/lib/routines/validate");
  const routine = await createRoutine({ name: "Bilan", clientName: "LPEV", dashboardId: null, metaAccountId: ACCOUNT, googleCustomerId: null }, { userId: ADMIN.userId });
  const checked = validateProposal(proposal);
  if (!checked.ok) throw new Error(checked.errors.join(" "));
  await applyDefinition(routine.id, { ...checked.value, writesPlatform: false }, { userId: ADMIN.userId });
  await setStatus(routine.id, ["ready"], "active", { activatedById: ADMIN.userId });
  return routine.id;
}

const sent: string[] = [];
let snapshot = "";
const state = () => JSON.stringify([db.routine.rows, db.routineRun.rows, db.routineItem.rows, db.routineEvent.rows]);

beforeEach(async () => {
  resetDb(); resetSteps(); sent.length = 0;
  for (const s of [CONSULTANT, PLAIN_CONSULTANT, ADMIN, CLIENT]) await db.user.create({ data: { id: s.userId, role: s.baseRole, email: s.user.email } });
  vi.stubEnv("ROUTINE_PLATFORM_WRITE_NEEDS_ADMIN", "");
  vi.stubEnv("META_SYSTEM_TOKEN", "EAAaccessTokenForTestsOnly000000000000000001");
  vi.stubEnv("META_RETRY_BASE_MS", "0");
  vi.stubGlobal("fetch", vi.fn(async (target: string | URL | Request) => {
    sent.push(String(target).replace(/access_token=[^&]+/, "access_token=…"));
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function statuses(who: Session | null): Promise<Array<[string, number]>> {
  const id = await seed();
  snapshot = state();
  session = who;
  const out: Array<[string, number]> = [];
  for (const c of await everyCall()) out.push([c.name, (await c.call(id))!.status]);
  return out;
}
const refused = (list: Array<[string, number]>, status: number) => list.map(([name]) => [name, status]);

describe("verrou de lancement — la règle", () => {
  it("fermé par défaut : absente, « admin » ou toute autre valeur réservent l'espace aux administrateurs réels", async () => {
    const { routinesAccessMode, hasRoutinesAccess } = await import("@/lib/routines/access-rule");
    for (const value of [undefined, "", "admin", "STAFF", "Staff", " staff", "staff ", "all", "1", "true", "consultant", "open"]) {
      const env = { ROUTINES_ACCESS: value };
      expect(routinesAccessMode(env), String(value)).toBe("admin");
      expect(hasRoutinesAccess(CONSULTANT, env), String(value)).toBe(false);
      expect(hasRoutinesAccess(PLAIN_CONSULTANT, env), String(value)).toBe(false);
      expect(hasRoutinesAccess(ADMIN, env), String(value)).toBe(true);
      expect(hasRoutinesAccess(CLIENT, env), String(value)).toBe(false);
    }
    expect(routinesAccessMode({})).toBe("admin");
  });

  it("« staff » ouvre à tout le personnel, jamais à un client ni à une session vide", async () => {
    const { routinesAccessMode, hasRoutinesAccess } = await import("@/lib/routines/access-rule");
    const env = { ROUTINES_ACCESS: "staff" };
    expect(routinesAccessMode(env)).toBe("staff");
    expect([CONSULTANT, PLAIN_CONSULTANT, ADMIN].map((s) => hasRoutinesAccess(s, env))).toEqual([true, true, true]);
    for (const nobody of [CLIENT, null, undefined, {}, { role: "admin", baseRole: "admin" }, { userId: "", role: "admin", baseRole: "admin" }]) {
      expect(hasRoutinesAccess(nobody as never, env)).toBe(false);
      expect(hasRoutinesAccess(nobody as never, {})).toBe(false);
    }
  });
});

describe("verrou de lancement — chaque route", () => {
  it.each([["absente", undefined], ["admin", "admin"], ["une valeur inconnue", "ouvert"]])("ROUTINES_ACCESS %s : le consultant est refusé (403) sur chaque route, et rien ne bouge", async (_label, value) => {
    if (value !== undefined) vi.stubEnv("ROUTINES_ACCESS", value);
    for (const who of [CONSULTANT, PLAIN_CONSULTANT]) {
      resetDb();
      for (const s of [CONSULTANT, PLAIN_CONSULTANT, ADMIN, CLIENT]) await db.user.create({ data: { id: s.userId, role: s.baseRole } });
      const seenStatuses = await statuses(who);
      expect(seenStatuses).toEqual(refused(seenStatuses, 403));
      expect(seenStatuses).toHaveLength(16);
      // Neither created, renamed, applied, activated, run nor archived; nothing read outside, no step run.
      expect(state()).toBe(snapshot);
      expect(sent).toEqual([]);
      expect(seen).toEqual([]);
    }
  });

  it("ROUTINES_ACCESS=staff : le consultant est accepté sur chaque route", async () => {
    vi.stubEnv("ROUTINES_ACCESS", "staff");
    for (const who of [CONSULTANT, PLAIN_CONSULTANT]) {
      resetDb();
      for (const s of [CONSULTANT, PLAIN_CONSULTANT, ADMIN, CLIENT]) await db.user.create({ data: { id: s.userId, role: s.baseRole } });
      // The scope of a plain consultant is a list of accounts: the account of the routine is theirs.
      await db.userAdAccount.create({ data: { userId: who.userId, platform: "meta", accountId: ACCOUNT } });
      const seenStatuses = await statuses(who);
      expect(seenStatuses.filter(([, status]) => status === 401 || status === 403)).toEqual([]);
      expect(Object.fromEntries(seenStatuses)).toMatchObject({ "GET /routines": 200, "POST /routines": 201, "GET /routines/[id]": 200, "GET runs": 200, "GET items": 200, "GET pages": 200 });
    }
  });

  it.each([["fermé", undefined], ["ouvert", "staff"]])("verrou %s : l'administrateur réel est accepté sur chaque route", async (_label, value) => {
    if (value) vi.stubEnv("ROUTINES_ACCESS", value);
    const seenStatuses = await statuses(ADMIN);
    expect(seenStatuses.filter(([, status]) => status === 401 || status === 403)).toEqual([]);
    expect(Object.fromEntries(seenStatuses)).toMatchObject({ "GET /routines": 200, "POST /routines": 201, "GET /routines/[id]": 200, "PATCH /routines/[id]": 200, "GET runs": 200, "GET items": 200, "GET pages": 200 });
  });

  it.each([["fermé", undefined], ["ouvert", "staff"]])("verrou %s : le client est refusé (403) sur chaque route, et une session vide aussi (401)", async (_label, value) => {
    if (value) vi.stubEnv("ROUTINES_ACCESS", value);
    const asClient = await statuses(CLIENT);
    expect(asClient).toEqual(refused(asClient, 403));
    expect(state()).toBe(snapshot);
    resetDb();
    await db.user.create({ data: { id: ADMIN.userId, role: "admin" } });
    const anonymous = await statuses(null);
    expect(anonymous).toEqual(refused(anonymous, 401));
    expect(sent).toEqual([]);
  });

  it("le réglage se lit à chaque requête : refermé, le consultant est refusé à la requête suivante", async () => {
    const list = await import("@/app/api/routines/route");
    session = CONSULTANT;
    vi.stubEnv("ROUTINES_ACCESS", "staff");
    expect((await list.GET(get()))!.status).toBe(200);
    vi.stubEnv("ROUTINES_ACCESS", "admin");
    expect((await list.GET(get()))!.status).toBe(403);
  });
});

describe("verrou de lancement — aucune route ne le contourne", () => {
  it("chaque fichier de route de app/api/routines appelle requireRoutinesAccess dans chacun de ses points d'entrée, et jamais requireStaff", () => {
    const files = routeFiles();
    expect(files.length).toBeGreaterThanOrEqual(11);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(ROOT, "app/api/routines", file), "utf8");
      const handlers = [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]);
      const exported = [...source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]);
      if (exported.length) offenders.push(`${file} : point d'entrée ${exported.join(", ")} exporté en constante, non vérifiable`);
      if (!handlers.length) offenders.push(`${file} : aucun point d'entrée trouvé`);
      if (!/import\s*\{[^}]*\brequireRoutinesAccess\b[^}]*\}\s*from\s*["']@\/lib\/routines\/access["']/.test(source)) offenders.push(`${file} : n'importe pas requireRoutinesAccess`);
      if (/\brequire(Staff|Session|Admin)\s*\(/.test(source)) offenders.push(`${file} : appelle une autre garde de session`);
      // Each handler: the guard is its first statement.
      const bodies = source.split(/export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/).slice(1);
      bodies.forEach((body, i) => {
        const open = body.indexOf("{", body.indexOf(")"));
        const first = body.slice(body.indexOf("{\n", open - 1) + 1).trimStart();
        if (!/^const guard = await requireRoutinesAccess\(\);\s*\n\s*if \("error" in guard\) return guard\.error;/.test(first)) {
          offenders.push(`${file} : ${handlers[i]} ne commence pas par requireRoutinesAccess()`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("l'essai ci-dessus appelle tous les fichiers de route du dossier : une route ajoutée doit y être ajoutée", async () => {
    const called = [...new Set((await everyCall()).map((c) => c.file))].sort();
    expect(called).toEqual(routeFiles());
  });

  it("le cron n'est pas concerné : il garde sa garde par CRON_SECRET, et exécute une routine active quel que soit le réglage", async () => {
    const source = readFileSync(path.join(ROOT, "app/api/cron/routines/route.ts"), "utf8");
    expect(source).toContain("CRON_SECRET");
    expect(source).not.toMatch(/requireRoutinesAccess|ROUTINES_ACCESS/);

    vi.stubEnv("CRON_SECRET", "cron-secret");
    vi.stubEnv("N8N_AUTO_ALERT_WEBHOOK_URL", "");
    const id = await seed();
    db.routine.rows.find((r) => r.id === id)!.nextRunAt = new Date(Date.now() - 60_000);
    session = null;
    const cron = await import("@/app/api/cron/routines/route");
    expect((await cron.GET(new NextRequest("http://x/api/cron/routines")))!.status).toBe(401);
    const res = await cron.GET(new NextRequest("http://x/api/cron/routines", { headers: { authorization: "Bearer cron-secret" } }));
    expect(await res!.json()).toMatchObject({ due: 1, ran: 1 });
    expect(seen.map((s) => s.stepId)).toEqual(["prevenir"]);
  });
});

describe("verrou de lancement — les pages et le menu", () => {
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

  it("la session porte la réponse du serveur, et le menu n'affiche « Routines » que sur elle", () => {
    expect(read("auth.ts")).toMatch(/routinesAccess: hasRoutinesAccess\(/);
    const sidebar = read("components/sidebar.tsx");
    expect(sidebar).toMatch(/href: "\/routines",[\s\S]{0,120}routinesOnly: true/);
    expect(sidebar).toMatch(/!it\.routinesOnly \|\| session\?\.routinesAccess === true/);
    // A client component: the environment is not read in the browser.
    expect(sidebar).toMatch(/^"use client"/);
    for (const file of ["components/sidebar.tsx", "app/routines/page.tsx", "app/routines/new/page.tsx", "app/routines/[id]/page.tsx"]) {
      expect(read(file), file).not.toMatch(/process\.env/);
    }
  });

  it("les pages redirigent qui n'a pas l'accès, dans le proxy et dans le gabarit des pages", async () => {
    const layout = read("app/routines/layout.tsx");
    expect(layout).toMatch(/if \(!hasRoutinesAccess\(session\)\) redirect\(/);
    expect(layout).not.toMatch(/^"use client"/);
    const proxy = read("proxy.ts");
    expect(proxy).toMatch(/isRoutinesPath\(pathname\) && !hasRoutinesAccess\(session\)/);
    const { isRoutinesPath } = await import("@/lib/routines/access-rule");
    for (const p of ["/routines", "/routines/new", "/routines/abc", "/api/routines", "/api/routines/abc/run", "/api/routines/pages"]) expect(isRoutinesPath(p), p).toBe(true);
    for (const p of ["/", "/routinesx", "/api/cron/routines", "/api/routine", "/reports", "/d/routines"]) expect(isRoutinesPath(p), p).toBe(false);
  });
});
