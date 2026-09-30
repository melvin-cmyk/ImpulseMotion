/**
 * Client alerts — private Slack messages: lib/client-alerts/slack-dm.ts and
 * /api/me/slack. n8n is a stand-in (`fetch` stubbed) and the User table a map:
 * no Slack message leaves the machine, no row is written.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

type Row = { email: string | null; slackEmail: string | null; slackUserId: string | null; slackCheckedAt: Date | null };

let session: { userId: string; role: string } | null = null;
const users = new Map<string, Row>();
const writes: Array<{ id: string; data: Partial<Row> }> = [];

vi.mock("@/lib/auth-helpers", () => ({
  requireStaff: async () => {
    if (!session) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
    if (session.role !== "admin" && session.role !== "consultant") return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
    return { session };
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const u = users.get(where.id);
        return u ? { ...u } : null;
      },
      // Another user whose LOGIN address is this one (what the address rule asks).
      findFirst: async ({ where }: { where: { email: { equals: string; mode?: string }; NOT: { id: string } } }) => {
        const wanted = where.email.equals.toLowerCase();
        const hit = [...users.entries()].find(([id, u]) => id !== where.NOT.id && (u.email ?? "").toLowerCase() === wanted);
        return hit ? { id: hit[0] } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const u = users.get(where.id);
        if (!u) throw new Error("no such user");
        Object.assign(u, data);
        writes.push({ id: where.id, data });
        return { ...u };
      },
    },
  },
}));

import {
  ADDRESS_TAKEN, MAX_DM_CHARS, SlackAddressError, SlackDmError, capDmText, cleanEmail, dmConfigured, dmWebhook, isSlackMemberId, lookupSlackUser, resolveSlackIdentity, sendSlackDm, slackIdentityOf,
} from "@/lib/client-alerts/slack-dm";
import { GET as READ, POST } from "@/app/api/me/slack/route";

const LEGACY = "https://n8n.test/webhook/impulsemotion-alerts";
const DM_URL = "https://n8n.test/webhook/impulsemotion-dm";
const MELVIN = "U01MELVIN99";
const CLAIRE = "U02CLAIRE88";

interface Sent { url: string; headers: Record<string, string>; body: Record<string, unknown> }
let sent: Sent[] = [];
/** What n8n answers: "slack" = as the workflow does, "down" = the request never gets through, else this very answer. */
let answer: { status: number; json?: unknown; text?: string } | "slack" | "down" = "slack";
/** Slack's directory, read by the stand-in when it answers as the workflow does. */
const directory = new Map<string, { id: string; name: string }>();

/** console.error of the route: where the technical cause of a Slack failure goes. */
let logged: ReturnType<typeof vi.spyOn>;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const row = (over: Partial<Row> = {}): Row => ({ email: "melvin@impulse-analytics.com", slackEmail: null, slackUserId: null, slackCheckedAt: null, ...over });
const GET = async () => (await READ())!;
const post = async (body: unknown) => (await POST(new Request("http://x/api/me/slack", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }) as never))!;
const lookups = () => sent.filter((s) => s.body.kind === "lookup");
const messages = () => sent.filter((s) => s.body.kind === "dm");

beforeEach(() => {
  sent = [];
  writes.length = 0;
  users.clear();
  directory.clear();
  directory.set("melvin@impulse-analytics.com", { id: MELVIN, name: "Melvin" });
  directory.set("claire@impulse-analytics.com", { id: CLAIRE, name: "Claire" });
  session = { userId: "u1", role: "consultant" };
  answer = "slack";
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("N8N_ALERT_WEBHOOK_URL", LEGACY);
  vi.stubEnv("N8N_DM_WEBHOOK_URL", "");
  vi.stubEnv("N8N_ALERT_WEBHOOK_SECRET", "secret-alertes");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    sent.push({ url: String(url), headers: init.headers as Record<string, string>, body });
    if (answer === "down") throw new TypeError("fetch failed");
    if (answer === "slack") return Response.json(body.kind === "lookup" ? { ok: true, user: directory.get(String(body.email)) ?? null } : { ok: true });
    return new Response(answer.text ?? JSON.stringify(answer.json), { status: answer.status });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("slack-dm — webhook", () => {
  it("derives the address from the webhook of the consultant alerts", () => {
    expect(dmWebhook()).toEqual({ url: DM_URL, secret: "secret-alertes" });
    vi.stubEnv("N8N_ALERT_WEBHOOK_URL", `${LEGACY}/`);
    expect(dmWebhook()?.url).toBe(DM_URL);
    expect(dmConfigured()).toBe(true);
  });

  it("prefers N8N_DM_WEBHOOK_URL when it is set", () => {
    vi.stubEnv("N8N_DM_WEBHOOK_URL", " https://autre.test/webhook/mp ");
    expect(dmWebhook()?.url).toBe("https://autre.test/webhook/mp");
    vi.stubEnv("N8N_ALERT_WEBHOOK_URL", "");
    expect(dmConfigured()).toBe(true);
  });

  it("is not configured without an address, with one that cannot be derived, or with the consultant webhook itself", () => {
    vi.stubEnv("N8N_ALERT_WEBHOOK_URL", "");
    expect(dmWebhook()).toBeNull();
    expect(dmConfigured()).toBe(false);
    vi.stubEnv("N8N_ALERT_WEBHOOK_URL", "https://n8n.test/webhook/autre-chose");
    expect(dmConfigured()).toBe(false);
    vi.stubEnv("N8N_DM_WEBHOOK_URL", "https://n8n.test/webhook/autre-chose");
    expect(dmConfigured()).toBe(false);
  });

  it("calls nothing when it is not configured", async () => {
    vi.stubEnv("N8N_ALERT_WEBHOOK_URL", "");
    await expect(lookupSlackUser("melvin@impulse-analytics.com")).rejects.toThrow("l'envoi des messages privés Slack n'est pas encore branché");
    await expect(sendSlackDm(MELVIN, "Bonjour")).rejects.toMatchObject({ detail: expect.stringMatching(/non configuré/) });
    expect(sent).toEqual([]);
  });
});

describe("slack-dm — lookup", () => {
  it("finds a member by address, with the secret and the version", async () => {
    expect(await lookupSlackUser("  Melvin@Impulse-Analytics.com ")).toEqual({ id: MELVIN, name: "Melvin" });
    expect(sent).toEqual([{
      url: DM_URL,
      headers: { "Content-Type": "application/json", "X-Alert-Secret": "secret-alertes" },
      body: { version: 1, kind: "lookup", email: "melvin@impulse-analytics.com" },
    }]);
  });

  it("returns null when Slack knows nobody with this address", async () => {
    expect(await lookupSlackUser("inconnu@impulse-analytics.com")).toBeNull();
  });

  it("keeps a name only when there is one", async () => {
    answer = { status: 200, json: { ok: true, user: { id: "W0123456789", name: "  " } } };
    expect(await lookupSlackUser("melvin@impulse-analytics.com")).toEqual({ id: "W0123456789", name: null });
  });

  it("throws on a failure: words for the consultant, Slack's code and the scope it asks for as the detail", async () => {
    const failure = async () => lookupSlackUser("melvin@impulse-analytics.com").then(() => null, (e: unknown) => e as SlackDmError);
    answer = { status: 200, json: { ok: false, error: "missing_scope", needed: "users:read.email" } };
    expect(await failure()).toMatchObject({ name: "SlackDmError", message: "l'application Slack n'a pas encore le droit d'envoyer des messages privés", detail: "missing_scope (users:read.email)" });
    answer = { status: 401, json: { ok: false, error: "unauthorized" } };
    expect(await failure()).toMatchObject({ message: "le service d'envoi vers Slack a refusé la demande", detail: "unauthorized" });
    answer = { status: 500, text: "Internal Server Error" };
    expect(await failure()).toMatchObject({ message: "le service d'envoi vers Slack a répondu par une erreur", detail: "n8n 500" });
    answer = "down";
    expect(await failure()).toMatchObject({ message: "le service d'envoi vers Slack est injoignable", detail: "n8n injoignable" });
    // A code nobody listed is still said in words.
    answer = { status: 200, json: { ok: false, error: "some_new_slack_code" } };
    expect(await failure()).toMatchObject({ message: "Slack a refusé l'envoi", detail: "some_new_slack_code" });
  });

  it("never puts a technical word in what a consultant reads", async () => {
    const answers = [
      { status: 200, json: { ok: false, error: "missing_scope", needed: "im:write" } }, { status: 200, json: { ok: false, error: "channel_not_found" } },
      { status: 200, json: { ok: false, error: "ratelimited" } }, { status: 200, json: { ok: false, error: "account_inactive" } },
      { status: 401, json: { ok: false, error: "unauthorized" } }, { status: 502, text: "Bad Gateway" }, { status: 200, text: "" }, "down",
    ] as const;
    for (const a of answers) {
      answer = a;
      const err = await sendSlackDm(MELVIN, "Bonjour").then(() => null, (e: unknown) => e as SlackDmError);
      expect(err, JSON.stringify(a)).toBeInstanceOf(SlackDmError);
      expect(err!.message, JSON.stringify(a)).not.toMatch(/n8n|webhook|scope|[a-z]+_[a-z_]+|\b\d{3}\b|json|http/i);
    }
  });

  it("never reads an odd answer as « nobody »", async () => {
    for (const json of [{}, { ok: true }, { ok: true, user: {} }, { ok: true, user: { id: "C0123456789", name: "canal" } }, { ok: true, user: "U0123456789" }, { user: null }]) {
      answer = { status: 200, json };
      await expect(lookupSlackUser("melvin@impulse-analytics.com"), JSON.stringify(json)).rejects.toThrow(/inattendue/);
    }
    answer = { status: 200, text: "" };
    await expect(lookupSlackUser("melvin@impulse-analytics.com")).rejects.toThrow(/inattendue/);
  });

  it("refuses what is not an address before any call", async () => {
    for (const bad of ["", "melvin", "melvin@", "@impulse.fr", "a b@x.fr", "melvin@impulse", "a@x.fr,b@x.fr", "<melvin@x.fr>", `${"a".repeat(70)}@x.fr`]) {
      expect(cleanEmail(bad), bad).toBeNull();
      await expect(lookupSlackUser(bad), bad).rejects.toThrow("adresse e-mail invalide");
    }
    expect(sent).toEqual([]);
  });
});

describe("slack-dm — private message", () => {
  it("sends the text to the member", async () => {
    await sendSlackDm(MELVIN, "*LPEV* — CPA au-dessus de 60 €");
    expect(sent).toEqual([{
      url: DM_URL,
      headers: { "Content-Type": "application/json", "X-Alert-Secret": "secret-alertes" },
      body: { version: 1, kind: "dm", slackUserId: MELVIN, text: "*LPEV* — CPA au-dessus de 60 €" },
    }]);
  });

  it("refuses channels and anything that is not a member id", async () => {
    expect(isSlackMemberId("U0123456789")).toBe(true);
    expect(isSlackMemberId("W0123456789")).toBe(true);
    for (const bad of ["C0123456789", "G0123456789", "D0123456789", "#c_lpev", "c_lpev", "@melvin", "melvin@impulse-analytics.com", "u0123456789", "U123", "U0123456789,C0123456789", "U0123456789 ", "", null, undefined, 42]) {
      expect(isSlackMemberId(bad), String(bad)).toBe(false);
      await expect(sendSlackDm(bad as string, "Bonjour"), String(bad)).rejects.toThrow(/destinataire Slack invalide/);
    }
    expect(sent).toEqual([]);
  });

  it("refuses an empty text", async () => {
    await expect(sendSlackDm(MELVIN, "")).rejects.toThrow("message vide");
    await expect(sendSlackDm(MELVIN, " \n\t ")).rejects.toThrow("message vide");
    expect(sent).toEqual([]);
  });

  it("cuts an oversized text on a line rather than failing", async () => {
    const line = "*Client* — une alerte qui se répète, avec ses chiffres et sa période";
    const long = Array.from({ length: 120 }, (_, i) => `${line} ${i}`).join("\n");
    expect(long.length).toBeGreaterThan(MAX_DM_CHARS);
    await sendSlackDm(MELVIN, long);
    const text = String(messages()[0].body.text);
    expect(text.length).toBeLessThanOrEqual(MAX_DM_CHARS);
    expect(text.endsWith("\n…")).toBe(true);
    const kept = text.slice(0, -2).split("\n");
    expect(kept.every((l, i) => l === `${line} ${i}`)).toBe(true);
    expect(kept.length).toBeGreaterThan(40);
  });

  it("leaves a short text alone, and never cuts inside a link or a character", () => {
    expect(capDmText("  Bonjour\r\nMelvin  ")).toBe("Bonjour\nMelvin");
    const link = `<https://app.test/alertes?${"x".repeat(40)}|Voir et régler mes alertes>`;
    const cut = capDmText(`${"mot ".repeat(20)}${link}`, 100);
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut).not.toContain("<");
    expect(cut.endsWith("\n…")).toBe(true);
    // The last space is inside the label of a link: the whole link goes.
    expect(capDmText(`${"x".repeat(60)} <https://app.test/a|Voir et régler mes alertes>`, 100)).toBe(`${"x".repeat(60)}\n…`);
    const emoji = capDmText("😀".repeat(100), 51);
    expect(emoji.length).toBeLessThanOrEqual(51);
    expect(emoji.slice(0, -2)).toBe("😀".repeat(24));
  });

  it("throws with Slack's code when the message is refused", async () => {
    answer = { status: 200, json: { ok: false, error: "channel_not_found", needed: null } };
    await expect(sendSlackDm(MELVIN, "Bonjour")).rejects.toMatchObject({ message: "Slack ne trouve pas la conversation privée avec ce compte", detail: "channel_not_found" });
    answer = { status: 400, json: { ok: false, error: "slackUserId must be a member id" } };
    await expect(sendSlackDm(MELVIN, "Bonjour")).rejects.toMatchObject({ message: "Slack a refusé l'envoi", detail: "slackUserId must be a member id" });
    answer = "down";
    await expect(sendSlackDm(MELVIN, "Bonjour")).rejects.toMatchObject({ detail: "n8n injoignable" });
  });

  it("does not call sent what n8n did not confirm", async () => {
    answer = { status: 200, text: "" };
    await expect(sendSlackDm(MELVIN, "Bonjour")).rejects.toThrow(/inattendue/);
    answer = { status: 200, json: { message: "Workflow was started" } };
    await expect(sendSlackDm(MELVIN, "Bonjour")).rejects.toThrow(/inattendue/);
  });
});

describe("slack-dm — identity", () => {
  it("reads the three states from the columns", () => {
    expect(slackIdentityOf(row())).toEqual({ email: "melvin@impulse-analytics.com", slackUserId: null, checkedAt: null, status: "unchecked" });
    const at = new Date("2026-09-29T08:00:00Z");
    expect(slackIdentityOf(row({ slackCheckedAt: at }))).toEqual({ email: "melvin@impulse-analytics.com", slackUserId: null, checkedAt: at.toISOString(), status: "unknown" });
    expect(slackIdentityOf(row({ slackUserId: MELVIN, slackCheckedAt: at }))).toEqual({ email: "melvin@impulse-analytics.com", slackUserId: MELVIN, checkedAt: at.toISOString(), status: "found" });
    // Found by an id stored before the date was: still found.
    expect(slackIdentityOf(row({ slackUserId: MELVIN })).status).toBe("found");
  });

  it("looks up slackEmail when there is one, the login address otherwise", () => {
    expect(slackIdentityOf(row({ slackEmail: "m.dupont@agence.fr" })).email).toBe("m.dupont@agence.fr");
    expect(slackIdentityOf(row({ slackEmail: "  " })).email).toBe("melvin@impulse-analytics.com");
    expect(slackIdentityOf(row({ email: null })).email).toBeNull();
  });

  it("does not call found an id that is not a member", () => {
    expect(slackIdentityOf(row({ slackUserId: "C0123456789" }))).toMatchObject({ slackUserId: null, status: "unchecked" });
  });
});

describe("slack-dm — resolveSlackIdentity", () => {
  it("returns a found identity as it is, without a call", async () => {
    users.set("u1", row({ slackUserId: MELVIN, slackCheckedAt: hoursAgo(500) }));
    expect(await resolveSlackIdentity("u1")).toMatchObject({ status: "found", slackUserId: MELVIN });
    expect(sent).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("looks up an address never checked, and stores the member and the date", async () => {
    users.set("u1", row());
    const before = Date.now();
    const identity = await resolveSlackIdentity("u1");
    expect(identity).toMatchObject({ status: "found", slackUserId: MELVIN, email: "melvin@impulse-analytics.com" });
    expect(lookups().map((s) => s.body.email)).toEqual(["melvin@impulse-analytics.com"]);
    expect(users.get("u1")!.slackUserId).toBe(MELVIN);
    expect(users.get("u1")!.slackCheckedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(identity.checkedAt).toBe(users.get("u1")!.slackCheckedAt!.toISOString());
  });

  it("stores « unknown » when Slack knows nobody, and asks again once a day at most", async () => {
    users.set("u1", row({ email: "inconnu@impulse-analytics.com" }));
    expect(await resolveSlackIdentity("u1")).toMatchObject({ status: "unknown", slackUserId: null });
    expect(users.get("u1")!.slackCheckedAt).not.toBeNull();
    expect(await resolveSlackIdentity("u1")).toMatchObject({ status: "unknown" });
    expect(lookups()).toHaveLength(1);

    users.get("u1")!.slackCheckedAt = hoursAgo(23);
    await resolveSlackIdentity("u1");
    expect(lookups()).toHaveLength(1);

    users.get("u1")!.slackCheckedAt = hoursAgo(25);
    directory.set("inconnu@impulse-analytics.com", { id: "U0NOUVEAU77", name: "Nouveau" });
    expect(await resolveSlackIdentity("u1")).toMatchObject({ status: "found", slackUserId: "U0NOUVEAU77" });
    expect(lookups()).toHaveLength(2);
  });

  it("asks again with force, whatever is stored", async () => {
    users.set("u1", row({ email: "inconnu@impulse-analytics.com", slackCheckedAt: hoursAgo(1) }));
    await resolveSlackIdentity("u1", { force: true });
    expect(lookups()).toHaveLength(1);

    // A member who left Slack: the id is forgotten.
    users.set("u2", row({ email: "parti@impulse-analytics.com", slackUserId: "U0PARTI0000", slackCheckedAt: hoursAgo(1) }));
    expect(await resolveSlackIdentity("u2", { force: true })).toMatchObject({ status: "unknown", slackUserId: null });
    expect(users.get("u2")!.slackUserId).toBeNull();
    expect(lookups()).toHaveLength(2);
  });

  it("changes the address first, forgets the member of the previous one, and looks the new one up", async () => {
    users.set("u1", row({ slackUserId: MELVIN, slackCheckedAt: hoursAgo(1) }));
    const identity = await resolveSlackIdentity("u1", { email: " Claire@Impulse-Analytics.com " });
    expect(identity).toMatchObject({ status: "found", email: "claire@impulse-analytics.com", slackUserId: CLAIRE });
    expect(writes[0]).toEqual({ id: "u1", data: { slackEmail: "claire@impulse-analytics.com", slackUserId: null, slackCheckedAt: null } });
    expect(users.get("u1")).toMatchObject({ slackEmail: "claire@impulse-analytics.com", slackUserId: CLAIRE });
    expect(lookups().map((s) => s.body.email)).toEqual(["claire@impulse-analytics.com"]);
  });

  it("refuses the login address of another person of the application, and stores nothing", async () => {
    users.set("u1", row({ slackUserId: MELVIN, slackCheckedAt: hoursAgo(1) }));
    users.set("u2", row({ email: "Claire@impulse-analytics.com" }));
    // Without this, the alerts of u1 would land in Claire's private messages.
    await expect(resolveSlackIdentity("u1", { email: "claire@impulse-analytics.com" })).rejects.toBeInstanceOf(SlackAddressError);
    await expect(resolveSlackIdentity("u1", { email: " CLAIRE@Impulse-Analytics.com " })).rejects.toThrow("Cette adresse est celle d'un autre compte ImpulseMotion.");
    expect(ADDRESS_TAKEN).toBe("Cette adresse est celle d'un autre compte ImpulseMotion.");
    expect(writes).toEqual([]);
    expect(sent).toEqual([]);
    expect(users.get("u1")).toEqual(row({ slackUserId: MELVIN, slackCheckedAt: users.get("u1")!.slackCheckedAt }));
    // An address that is nobody's login — a personal Slack address — is still accepted.
    directory.set("melvin.perso@exemple.fr", { id: "U03PERSO777", name: "Melvin" });
    expect(await resolveSlackIdentity("u1", { email: "melvin.perso@exemple.fr" })).toMatchObject({ status: "found", slackUserId: "U03PERSO777" });
    // Another person's SLACK address that is not their login is not the rule's business.
    users.set("u3", row({ email: "sam@impulse-analytics.com", slackEmail: "sam.perso@exemple.fr" }));
    directory.set("sam.perso@exemple.fr", { id: "U04SAMPERSO", name: "Sam" });
    expect((await resolveSlackIdentity("u1", { email: "sam.perso@exemple.fr" })).status).toBe("found");
  });

  it("gives the name Slack answered right after a lookup, without storing it", async () => {
    users.set("u1", row());
    const looked = await resolveSlackIdentity("u1");
    expect(looked).toMatchObject({ status: "found", slackUserId: MELVIN, name: "Melvin" });
    expect(writes[0].data).toEqual({ slackUserId: MELVIN, slackCheckedAt: expect.any(Date) });
    // Read from what is stored: no name — nothing of it was kept.
    expect(await resolveSlackIdentity("u1")).not.toHaveProperty("name");
    expect(slackIdentityOf(users.get("u1")!)).not.toHaveProperty("name");
    // Nobody found: no name.
    users.set("u2", row({ email: "absente@impulse-analytics.com" }));
    expect(await resolveSlackIdentity("u2")).toMatchObject({ status: "unknown", name: null });
  });

  it("goes back to the login address with null or an empty string", async () => {
    for (const email of [null, "", "  ", "melvin@impulse-analytics.com"]) {
      sent = [];
      users.set("u1", row({ slackEmail: "claire@impulse-analytics.com", slackUserId: CLAIRE, slackCheckedAt: hoursAgo(1) }));
      const identity = await resolveSlackIdentity("u1", { email });
      expect(identity, String(email)).toMatchObject({ status: "found", email: "melvin@impulse-analytics.com", slackUserId: MELVIN });
      expect(users.get("u1")!.slackEmail).toBeNull();
      expect(lookups().map((s) => s.body.email)).toEqual(["melvin@impulse-analytics.com"]);
    }
  });

  it("keeps the member when the address given is the one already looked up", async () => {
    users.set("u1", row({ slackUserId: MELVIN, slackCheckedAt: hoursAgo(1) }));
    expect(await resolveSlackIdentity("u1", { email: "melvin@impulse-analytics.com" })).toMatchObject({ status: "found", slackUserId: MELVIN });
    expect(await resolveSlackIdentity("u1", { email: null })).toMatchObject({ status: "found", slackUserId: MELVIN });
    expect(sent).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("refuses an address that is not one, and stores nothing", async () => {
    users.set("u1", row({ slackUserId: MELVIN, slackCheckedAt: hoursAgo(1) }));
    await expect(resolveSlackIdentity("u1", { email: "pas une adresse" })).rejects.toThrow("adresse e-mail invalide");
    expect(writes).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("never stores a failure of n8n or Slack as « unknown »", async () => {
    users.set("u1", row());
    for (const failing of ["down", { status: 200, json: { ok: false, error: "ratelimited" } }, { status: 502, text: "Bad Gateway" }, { status: 200, text: "" }] as const) {
      answer = failing;
      await expect(resolveSlackIdentity("u1")).rejects.toThrow();
    }
    expect(users.get("u1")).toEqual(row());
    expect(writes).toEqual([]);

    // A member already found survives a forced check that fails.
    const checked = hoursAgo(30);
    users.set("u2", row({ slackUserId: MELVIN, slackCheckedAt: checked }));
    answer = "down";
    await expect(resolveSlackIdentity("u2", { force: true })).rejects.toMatchObject({ detail: "n8n injoignable" });
    expect(users.get("u2")).toEqual(row({ slackUserId: MELVIN, slackCheckedAt: checked }));

    // A new address whose lookup fails is « never checked », not « unknown ».
    await expect(resolveSlackIdentity("u2", { force: true, email: "claire@impulse-analytics.com" })).rejects.toMatchObject({ detail: "n8n injoignable" });
    expect(slackIdentityOf(users.get("u2")!)).toEqual({ email: "claire@impulse-analytics.com", slackUserId: null, checkedAt: null, status: "unchecked" });
  });

  it("answers « unknown » without a call for a person without any address", async () => {
    users.set("u1", row({ email: null }));
    expect(await resolveSlackIdentity("u1", { force: true })).toEqual({ email: null, slackUserId: null, checkedAt: null, status: "unknown" });
    expect(sent).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("throws for a person who does not exist", async () => {
    await expect(resolveSlackIdentity("personne")).rejects.toThrow("utilisateur introuvable");
    expect(sent).toEqual([]);
  });
});

describe("/api/me/slack", () => {
  it("is closed to anyone but the staff, reading or writing", async () => {
    users.set("u1", row());
    for (const who of [null, { userId: "u1", role: "client" }]) {
      session = who;
      const status = who ? 403 : 401;
      expect((await GET()).status).toBe(status);
      expect((await post({ action: "check" })).status).toBe(status);
      expect((await post({ action: "test" })).status).toBe(status);
    }
    expect(sent).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("GET returns what is stored, without asking Slack", async () => {
    users.set("u1", row());
    expect(await (await GET()).json()).toEqual({ configured: true, identity: { email: "melvin@impulse-analytics.com", slackUserId: null, checkedAt: null, status: "unchecked" } });
    vi.stubEnv("N8N_ALERT_WEBHOOK_URL", "");
    users.set("u1", row({ slackUserId: MELVIN, slackCheckedAt: new Date("2026-09-29T08:00:00Z") }));
    expect(await (await GET()).json()).toEqual({ configured: false, identity: { email: "melvin@impulse-analytics.com", slackUserId: MELVIN, checkedAt: "2026-09-29T08:00:00.000Z", status: "found" } });
    expect(sent).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("check looks the caller up again, even when already found", async () => {
    users.set("u1", row({ slackUserId: "U0ANCIEN000", slackCheckedAt: hoursAgo(1) }));
    const res = await post({ action: "check" });
    expect(res.status).toBe(200);
    expect((await res.json()).identity).toMatchObject({ status: "found", slackUserId: MELVIN, email: "melvin@impulse-analytics.com" });
    expect(lookups()).toHaveLength(1);
  });

  it("check changes the address when one is given, and goes back to the login address with null", async () => {
    users.set("u1", row());
    expect((await (await post({ action: "check", email: "claire@impulse-analytics.com" })).json()).identity).toMatchObject({ status: "found", email: "claire@impulse-analytics.com", slackUserId: CLAIRE });
    expect(users.get("u1")!.slackEmail).toBe("claire@impulse-analytics.com");
    expect((await (await post({ action: "check", email: null })).json()).identity).toMatchObject({ status: "found", email: "melvin@impulse-analytics.com", slackUserId: MELVIN });
    expect(users.get("u1")!.slackEmail).toBeNull();
    expect((await (await post({ action: "check", email: "absente@impulse-analytics.com" })).json()).identity).toMatchObject({ status: "unknown", slackUserId: null });
  });

  it("check refuses the login address of another user, before asking Slack anything", async () => {
    users.set("u1", row({ slackUserId: MELVIN, slackCheckedAt: hoursAgo(1) }));
    users.set("u2", row({ email: "claire@impulse-analytics.com" }));
    const res = await post({ action: "check", email: "Claire@Impulse-Analytics.com" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Cette adresse est celle d'un autre compte ImpulseMotion.");
    expect(sent).toEqual([]);
    expect(writes).toEqual([]);
    expect(users.get("u1")).toMatchObject({ slackEmail: null, slackUserId: MELVIN });
    // One's own login address is of course fine.
    expect((await post({ action: "check", email: "melvin@impulse-analytics.com" })).status).toBe(200);
  });

  it("check answers with the name of the member Slack found", async () => {
    users.set("u1", row());
    const json = await (await post({ action: "check" })).json();
    expect(json.identity).toMatchObject({ status: "found", email: "melvin@impulse-analytics.com", name: "Melvin" });
  });

  it("check refuses an address that is not one", async () => {
    users.set("u1", row({ slackUserId: MELVIN }));
    for (const email of ["pas une adresse", 42, ["a@x.fr"], { a: 1 }]) {
      const res = await post({ action: "check", email });
      expect(res.status, String(email)).toBe(400);
      expect((await res.json()).error).toBe("Adresse e-mail invalide.");
    }
    expect(sent).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("check answers 502 in French when n8n or Slack fails, and keeps what was stored", async () => {
    users.set("u1", row({ slackUserId: MELVIN, slackCheckedAt: hoursAgo(1) }));
    answer = { status: 200, json: { ok: false, error: "missing_scope", needed: "users:read.email" } };
    const res = await post({ action: "check" });
    expect(res.status).toBe(502);
    // The consultant reads words; Slack's code and the scope go to the logs.
    expect((await res.json()).error).toBe("Slack n'a pas pu être interrogé : l'application Slack n'a pas encore le droit d'envoyer des messages privés. Réessayez dans quelques minutes.");
    expect(logged).toHaveBeenCalledWith("[client-alerts] slack", "missing_scope (users:read.email)");
    expect(users.get("u1")!.slackUserId).toBe(MELVIN);
  });

  it("test sends one private message to the caller", async () => {
    users.set("u1", row({ slackUserId: MELVIN, slackCheckedAt: hoursAgo(1) }));
    const res = await post({ action: "test" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(sent.map((s) => s.body)).toEqual([{ version: 1, kind: "dm", slackUserId: MELVIN, text: "Test ImpulseMotion : vos alertes arriveront ici, en message privé." }]);
  });

  it("test cannot target someone else, whatever the request says", async () => {
    users.set("u1", row({ slackUserId: MELVIN, slackCheckedAt: hoursAgo(1) }));
    users.set("u2", row({ email: "claire@impulse-analytics.com", slackUserId: CLAIRE, slackCheckedAt: hoursAgo(1) }));
    const res = await post({ action: "test", slackUserId: CLAIRE, userId: "u2", email: "claire@impulse-analytics.com", channel: "C0123456789", text: "Autre texte", identity: { slackUserId: CLAIRE } });
    expect(res.status).toBe(200);
    expect(messages().map((s) => s.body.slackUserId)).toEqual([MELVIN]);
    expect(messages()[0].body.text).toBe("Test ImpulseMotion : vos alertes arriveront ici, en message privé.");
    expect(users.get("u1")).toMatchObject({ slackEmail: null, slackUserId: MELVIN });
    expect(writes).toEqual([]);
  });

  it("test looks the caller up first when it was never done, and answers 409 when Slack knows nobody", async () => {
    users.set("u1", row());
    expect((await post({ action: "test" })).status).toBe(200);
    expect(sent.map((s) => s.body.kind)).toEqual(["lookup", "dm"]);

    sent = [];
    users.set("u1", row({ email: "absente@impulse-analytics.com" }));
    const res = await post({ action: "test" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Votre compte Slack n'a pas été trouvé avec l'adresse absente@impulse-analytics.com. Vérifiez l'adresse, puis relancez la recherche.");
    expect(messages()).toEqual([]);
  });

  it("test answers 502 in French when the message is refused", async () => {
    users.set("u1", row({ slackUserId: MELVIN, slackCheckedAt: hoursAgo(1) }));
    answer = { status: 200, json: { ok: false, error: "channel_not_found" } };
    const res = await post({ action: "test" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Le message de test n'a pas pu être envoyé : Slack ne trouve pas la conversation privée avec ce compte. Réessayez dans quelques minutes.");
  });

  it("refuses an unknown action, and says when the webhook is not set", async () => {
    users.set("u1", row({ slackUserId: MELVIN }));
    for (const body of [{}, { action: "dm", slackUserId: CLAIRE, text: "x" }, { action: null }, "pas du json", []]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe("Action inconnue.");
    }
    vi.stubEnv("N8N_ALERT_WEBHOOK_URL", "");
    for (const action of ["check", "test"]) {
      const res = await post({ action });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("Les messages privés Slack ne sont pas encore configurés.");
    }
    expect(sent).toEqual([]);
  });
});
