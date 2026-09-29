/**
 * Routines — hardening, second series: the guards of the two messages the
 * engine sends by itself (the routine switched itself off; the routine is
 * degraded). Each has a guard of its own, minted for the sending and REVOKED
 * after it: a guard left valid would be one a late caller could write with.
 *
 * The senders are wrapped to keep the guard they were handed; everything else
 * is real (engine, store, notify), the step handlers replaced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handed = vi.hoisted(() => ({ guards: [] as Array<{ which: string; guard: unknown; validWhenSent: boolean }> }));

vi.mock("@/lib/prisma", async () => ({ prisma: (await import("./routines-engine-fakes")).db }));
vi.mock("@/lib/routines/steps/sheet-read", async () => ({ sheetReadHandler: (await import("./routines-engine-fakes")).fakeHandler("sheet.read") }));
vi.mock("@/lib/routines/steps/sheet-write", async () => ({ sheetWriteHandler: (await import("./routines-engine-fakes")).fakeHandler("sheet.write") }));
vi.mock("@/lib/routines/steps/google-insights", async () => ({ googleInsightsHandler: (await import("./routines-engine-fakes")).fakeHandler("google.insights") }));
vi.mock("@/lib/routines/steps/slack-message", async () => ({ slackMessageHandler: (await import("./routines-engine-fakes")).fakeHandler("slack.message") }));
vi.mock("@/lib/routines/steps/email-send", async () => ({ emailSendHandler: (await import("./routines-engine-fakes")).fakeHandler("email.send") }));
vi.mock("@/lib/routines/steps/meta-insights", async () => ({ metaInsightsHandler: (await import("./routines-engine-fakes")).fakeHandler("meta.insights") }));
vi.mock("@/lib/routines/steps/meta-create-ads", async () => ({ metaCreateAdsHandler: (await import("./routines-engine-fakes")).fakeHandler("meta.create_ads") }));
vi.mock("@/lib/routines/steps/ai-summary", async () => ({ aiSummaryHandler: (await import("./routines-engine-fakes")).fakeHandler("ai.summary") }));
vi.mock("@/lib/routines/notify", async (original) => {
  const real = await original<typeof import("@/lib/routines/notify")>();
  const { isWriteGuard } = await import("@/lib/routines/write-guard-check");
  const keep = <A extends unknown[], R>(which: string, send: ((...args: A) => R) | undefined) => (...args: A): R => {
    handed.guards.push({ which, guard: args[0], validWhenSent: isWriteGuard(args[0]) });
    return send!(...args);
  };
  return {
    ...real,
    notifyAutoDisabled: keep("arrêt", real.notifyAutoDisabled),
    notifyDegraded: keep("dégradation", (real as unknown as { notifyDegraded?: (...a: unknown[]) => unknown }).notifyDegraded),
  };
});

import { runRoutine } from "@/lib/routines/engine";
import { hashDefinition } from "@/lib/routines/hash";
import { sendSlackMessage } from "@/lib/routines/notify";
import { getRoutine } from "@/lib/routines/store";
import { assertWriteGuard, isWriteGuard } from "@/lib/routines/write-guard-check";
import type { RoutineDefinition, WriteGuard } from "@/lib/routines/types";
import { behaviours, db, okOutcome, resetDb, resetSteps } from "./routines-engine-fakes";

const N8N = "https://n8n.example.org/webhook/impulsemotion-auto-alerts";
const ACCOUNT = "act_564381881705822";
const sent: string[] = [];

async function seed(): Promise<string> {
  const definition = { version: 1, steps: [{ id: "lire", type: "sheet.read", sheet: { spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", tab: "Créas" }, requiredColumns: ["id"] }] } as RoutineDefinition;
  const schedule = { kind: "daily" as const, time: "09:00" };
  await db.user.create({ data: { id: "u1", role: "consultant", email: "lea@impulse.test" } });
  await db.alertClient.create({ data: { name: "LPEV", accountsJson: JSON.stringify([{ platform: "meta", accountId: ACCOUNT }]), slackChannel: "#i_lpev" } });
  const row = await db.routine.create({
    data: {
      name: "Créas", status: "active", createdById: "u1", activatedById: "u1", metaAccountId: ACCOUNT, clientName: "LPEV",
      definitionJson: JSON.stringify(definition), scheduleJson: JSON.stringify(schedule), maxItemsPerRun: 20,
      definitionHash: hashDefinition({ definition, schedule, maxItemsPerRun: 20, metaAccountId: ACCOUNT, googleCustomerId: null, timezone: "Europe/Paris" }),
    },
  });
  return String(row.id);
}
const run = async (id: string, n: number) => runRoutine((await getRoutine(id))!, { mode: "live", trigger: "manual", startedById: "u1", now: new Date(Date.UTC(2026, 8, 29, 8, n)) });

beforeEach(() => {
  resetDb(); resetSteps(); sent.length = 0; handed.guards.length = 0;
  vi.stubEnv("N8N_AUTO_ALERT_WEBHOOK_URL", N8N);
  vi.stubEnv("N8N_ALERT_WEBHOOK_SECRET", "n8n-secret-value");
  vi.stubGlobal("fetch", vi.fn(async (t: string | URL | Request) => { sent.push(String(t)); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** Valid while the message left, revoked since: nothing can be written with it afterwards. */
async function expectRevoked(which: string): Promise<void> {
  const kept = handed.guards.filter((g) => g.which === which);
  expect(kept).toHaveLength(1);
  expect(kept[0].validWhenSent).toBe(true);
  const guard = kept[0].guard as WriteGuard;
  expect(isWriteGuard(guard)).toBe(false);
  expect(() => assertWriteGuard(guard)).toThrow(/révoquée/);
  const before = sent.length;
  await expect(sendSlackMessage(guard, { channel: "#i_lpev", text: "après", routine: { id: "r", name: "n" } })).rejects.toThrow(/révoquée/);
  expect(sent.length).toBe(before);
}

describe("M3f — la garde de l'annonce d'arrêt est révoquée après l'envoi", () => {
  it("arrêt automatique : le message part avec une autorisation valable, qui ne vaut plus rien ensuite", async () => {
    behaviours["sheet.read"] = () => ({ ...okOutcome(), status: "failed" as const, error: { class: "functional" as const, message: "Onglet introuvable" } });
    const id = await seed();
    for (let n = 0; n < 3; n++) await run(id, n);
    expect((await getRoutine(id))?.status).toBe("error");
    expect(sent).toEqual([N8N]);
    await expectRevoked("arrêt");
  });

  it("message de dégradation : même règle", async () => {
    behaviours["sheet.read"] = () => ({ ...okOutcome(), status: "failed" as const, error: { class: "infra" as const, message: "Relay inaccessible" } });
    const id = await seed();
    for (let n = 0; n < 4; n++) await run(id, n);
    expect((await getRoutine(id))?.status).toBe("active");
    expect(sent).toEqual([N8N]);
    await expectRevoked("dégradation");
  });
});
