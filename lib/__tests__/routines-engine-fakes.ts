/**
 * Test doubles of the routines: a Prisma held in memory and step handlers
 * whose behaviour each test decides. No database, no network.
 *
 * The handlers of the other lots (Sheet, Meta, Google, Slack, e-mail, AI) are
 * replaced file by file, so these tests say what the engine, the validation
 * and the routes do, whatever those files contain.
 */

import { STEP_WRITES, type RoutineStep, type StepContext, type StepHandler, type StepRunOutcome, type StepType } from "@/lib/routines/types";

// ── Prisma in memory ─────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

const cmp = (a: unknown, b: unknown) => (a instanceof Date ? a.getTime() : (a as number)) - (b instanceof Date ? b.getTime() : (b as number));
const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function matches(row: Rec, where: Rec | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === "OR") return (cond as Rec[]).some((w) => matches(row, w));
    if (key === "AND") return (cond as Rec[]).every((w) => matches(row, w));
    const value = row[key] ?? null;
    if (cond === null || typeof cond !== "object" || cond instanceof Date) return same(value, cond);
    const c = cond as Rec;
    if ("in" in c && !(c.in as unknown[]).some((v) => same(v, value))) return false;
    if ("not" in c && same(value, c.not)) return false;
    if ("lt" in c && !(value !== null && cmp(value, c.lt) < 0)) return false;
    if ("lte" in c && !(value !== null && cmp(value, c.lte) <= 0)) return false;
    if ("gt" in c && !(value !== null && cmp(value, c.gt) > 0)) return false;
    if ("gte" in c && !(value !== null && cmp(value, c.gte) >= 0)) return false;
    return true;
  });
}

function patch(row: Rec, data: Rec): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value && typeof value === "object" && !(value instanceof Date) && "increment" in (value as Rec)) {
      row[key] = Number(row[key] ?? 0) + Number((value as Rec).increment);
    } else row[key] = value;
  }
  if ("updatedAt" in row) row.updatedAt = new Date();
}

function pick(row: Rec, select?: Rec): Rec {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

let seq = 0;
const newId = () => `c${(++seq).toString(36).padStart(11, "0")}`;

class UniqueViolation extends Error {
  code = "P2002";
  constructor() { super("Unique constraint failed"); this.name = "PrismaClientKnownRequestError"; }
}

function table(defaults: () => Rec, unique?: (row: Rec) => string) {
  const rows: Rec[] = [];
  const api = {
    rows,
    /** Every call that changes the table, for the tests that count the writes. */
    writes: [] as string[],
    async create({ data, select }: { data: Rec; select?: Rec }) {
      // The insert waits like a real one, so that concurrent callers interleave.
      await Promise.resolve();
      const row: Rec = { id: newId(), ...defaults(), ...data };
      if (unique && rows.some((r) => unique(r) === unique(row))) throw new UniqueViolation();
      rows.push(row);
      api.writes.push("create");
      return pick(row, select);
    },
    async findUnique({ where, select }: { where: Rec; select?: Rec }) {
      const flat = Object.values(where).every((v) => v === null || typeof v !== "object") ? where : (Object.values(where)[0] as Rec);
      const row = rows.find((r) => matches(r, flat));
      return row ? pick(row, select) : null;
    },
    async findFirst(args: { where?: Rec; select?: Rec; orderBy?: Rec } = {}) {
      return (await api.findMany({ ...args, take: 1 }))[0] ?? null;
    },
    async findMany({ where, select, orderBy, skip, take }: { where?: Rec; select?: Rec; orderBy?: Rec; skip?: number; take?: number } = {}) {
      let out = rows.filter((r) => matches(r, where));
      if (orderBy) {
        const [key, dir] = Object.entries(orderBy)[0];
        out = [...out].sort((a, b) => (dir === "desc" ? -1 : 1) * cmp(a[key] ?? 0, b[key] ?? 0));
      }
      return out.slice(skip ?? 0, take === undefined ? undefined : (skip ?? 0) + take).map((r) => pick(r, select));
    },
    async count({ where }: { where?: Rec } = {}) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async update({ where, data, select }: { where: Rec; data: Rec; select?: Rec }) {
      await Promise.resolve();
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error("Record to update not found");
      patch(row, data);
      api.writes.push("update");
      return pick(row, select);
    },
    /** Test and write in one go, as the database does: no await between the two. */
    async updateMany({ where, data }: { where?: Rec; data: Rec }) {
      await Promise.resolve();
      const hit = rows.filter((r) => matches(r, where));
      for (const row of hit) patch(row, data);
      if (hit.length) api.writes.push("updateMany");
      return { count: hit.length };
    },
  };
  return api;
}

export const db = {
  routine: table(() => ({
    description: null, status: "draft", createdByEmail: null, dashboardId: null, clientName: "—",
    metaAccountId: null, googleCustomerId: null, definitionJson: "{}", definitionHash: "", writesPlatform: false,
    scheduleJson: "{}", timezone: "Europe/Paris", nextRunAt: null, lockedUntil: null, lastRunAt: null, lastRunStatus: null,
    consecutiveFailures: 0, maxItemsPerRun: 20, dryRunHash: null, dryRunAt: null, activatedById: null, activatedAt: null,
    chatJson: "{}", createdAt: new Date(), updatedAt: new Date(),
  })),
  routineRun: table(() => ({
    status: "running", startedById: null, startedAt: new Date(), finishedAt: null, durationMs: 0,
    itemsPlanned: 0, itemsCreated: 0, itemsSkipped: 0, itemsFailed: 0, stepsJson: "[]", error: null,
  })),
  routineItem: table(
    () => ({ runId: null, status: "pending", externalId: null, label: null, error: null, attempts: 1, createdAt: new Date(), updatedAt: new Date() }),
    (r) => `${r.routineId}\u0000${r.itemKey}`,
  ),
  routineEvent: table(() => ({ userId: null, userEmail: null, userRole: null, definitionHash: null, detail: null, createdAt: new Date() })),
  user: table(() => ({ role: "consultant" })),
  dashboard: table(() => ({ name: "Pilotage", metaAccountId: null, googleCustomerId: null })),
  userAdAccount: table(() => ({})),
  // Read or written by the real steps (integration tests): account settings, AI ledger, internal Slack channels.
  accountSetting: table(() => ({ platform: "meta", aov: null, currency: null, timezone: null, conversionEvent: null })),
  aiUsage: table(() => ({ createdAt: new Date() })),
  alertClient: table(() => ({ accountsJson: "[]", dashboardId: null, slackChannel: null, slackChannelId: null, gone: false })),
};

export function resetDb(): void {
  for (const t of Object.values(db)) { t.rows.length = 0; t.writes.length = 0; }
}

// ── Step handlers ────────────────────────────────────────────────────────

export type Behaviour = (step: RoutineStep, ctx: StepContext) => Promise<Partial<StepRunOutcome>> | Partial<StepRunOutcome>;

/** What each replaced step does when it runs; a test sets the ones it needs. */
export const behaviours: Partial<Record<StepType, Behaviour>> = {};
/** Every context a replaced step was run with. */
export const seen: Array<{ type: StepType; stepId: string; ctx: StepContext }> = [];
export const preflights: Partial<Record<StepType, StepHandler["preflight"]>> = {};

export function resetSteps(): void {
  for (const key of Object.keys(behaviours)) delete behaviours[key as StepType];
  for (const key of Object.keys(preflights)) delete preflights[key as StepType];
  seen.length = 0;
}

export const okOutcome = (extra: Partial<StepRunOutcome> = {}): StepRunOutcome => ({
  status: "ok", rowsIn: 0, rowsOut: extra.output?.rows?.rows.length ?? 0, output: {}, planned: [], written: [], warnings: [], ...extra,
});

/** Accepts any object with an id: the checks under test are those of validate.ts. */
export function fakeHandler(type: StepType): StepHandler {
  return {
    type,
    writes: STEP_WRITES[type],
    validate: (raw) => (typeof raw === "object" && raw !== null
      ? { ok: true, step: JSON.parse(JSON.stringify(raw)) as RoutineStep }
      : { ok: false, error: "objet attendu" }),
    preflight: async (step, routine) => (preflights[type] ? preflights[type]!(step, routine) : []),
    run: async (step, ctx) => {
      seen.push({ type, stepId: step.id, ctx });
      const out = await (behaviours[type] ?? (() => okOutcome()))(step, ctx);
      return out as StepRunOutcome;
    },
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────

export const SHEET = { spreadsheetId: "sheet-1", tab: "Créas" };

export const readStep = { id: "lire", type: "sheet.read", sheet: SHEET, requiredColumns: ["id", "nom", "statut"] } as const;
export const slackStep = { id: "prevenir", type: "slack.message", channel: "#client", text: "Bilan du {{run.date}}" } as const;
export const createAdsStep = {
  id: "creer", type: "meta.create_ads", campaignId: "120210000000000001", adsetId: "120210000000000002", pageId: "104000000000001", keyColumn: "id",
  mapping: { adName: "{{row.nom}}", primaryText: "{{row.texte}}", linkUrl: "{{row.lien}}", mediaType: "image", mediaUrl: "{{row.image}}" },
} as const;
