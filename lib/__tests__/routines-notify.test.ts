/**
 * Routines — messages: lib/routines/notify.ts and the steps slack.message and
 * email.send. n8n is a stand-in (`fetch` stubbed): no Slack message and no
 * e-mail leaves the machine.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMAIL_NOT_CONFIGURED, MAX_SLACK_CHARS, cleanRecipients, cleanSlackChannel, cleanSubject, defuseSlack, renderTable,
  routinesWebhook, sendEmail, sendSlackMessage, truncateText,
} from "@/lib/routines/notify";
import { emailSendHandler } from "@/lib/routines/steps/email-send";
import { slackMessageHandler } from "@/lib/routines/steps/slack-message";
import { mintWriteGuard } from "@/lib/routines/write-guard";
import type { EmailSendStep, RowSet, SlackMessageStep, StepContext, WriteGuard } from "@/lib/routines/types";

const SLACK_URL = "https://n8n.test/webhook/impulsemotion-auto-alerts";
const EMAIL_URL = "https://n8n.test/webhook/impulsemotion-routines";

interface Sent { url: string; headers: Record<string, string>; body: Record<string, unknown> }
let sent: Sent[] = [];
let answer: { status: number; json: unknown } | "down" = { status: 200, json: { ok: true } };

const routine: StepContext["routine"] = { id: "r1", name: "Bilan hebdo", metaAccountId: null, googleCustomerId: null, timezone: "Europe/Paris", maxItemsPerRun: 20 };
function context(input: RowSet | null, write: WriteGuard | null, outputs: StepContext["outputs"] = {}): StepContext {
  return {
    mode: write ? "live" : "dry_run", routine, runId: "run1", now: new Date("2026-09-29T08:00:00Z"), deadlineAt: Date.now() + 60_000,
    input, outputs, write,
    claimItem: async () => { throw new Error("un message ne réserve pas d'élément"); },
    settleItem: async () => { throw new Error("un message ne solde pas d'élément"); },
  };
}
const live = () => mintWriteGuard("live", "run1");
const campaigns = (n: number): RowSet => ({
  columns: ["campagne", "spend", "cpa"], truncated: false,
  rows: Array.from({ length: n }, (_, i) => ({ campagne: `Campagne ${i + 1}`, spend: 100.456 + i, cpa: i % 2 ? null : 12.5 })),
});

beforeEach(() => {
  sent = [];
  answer = { status: 200, json: { ok: true } };
  vi.stubEnv("N8N_AUTO_ALERT_WEBHOOK_URL", SLACK_URL);
  vi.stubEnv("N8N_ROUTINES_WEBHOOK_URL", EMAIL_URL);
  vi.stubEnv("N8N_ROUTINES_WEBHOOK_SECRET", "secret-routines");
  vi.stubEnv("N8N_ALERT_WEBHOOK_SECRET", "secret-alertes");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    if (answer === "down") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(answer.json), { status: answer.status });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("notify — validation", () => {
  it("accepts Slack channels by name or id, refuses the rest", () => {
    expect(cleanSlackChannel("c_lpev")).toBe("#c_lpev");
    expect(cleanSlackChannel("#c_lpev")).toBe("#c_lpev");
    expect(cleanSlackChannel("C0123ABCDE")).toBe("C0123ABCDE");
    for (const bad of ["", "  ", "#", "#Canal Majuscule", "c lpev", "@melvin", "<!channel>", "#c_lpev\n#autre", "https://hooks.slack.com/services/x", "#c_lpev,#autre", "x".repeat(90), null, 3, ["#c_lpev"], { channel: "#c" }]) {
      expect(cleanSlackChannel(bad), String(bad)).toBeNull();
    }
  });

  it("accepts five e-mail addresses at most, cleaned and deduplicated", () => {
    expect(cleanRecipients([" Melvin@Impulse-Analytics.com ", "melvin@impulse-analytics.com", "a.b+c@x.co.uk"])).toEqual({ ok: true, to: ["melvin@impulse-analytics.com", "a.b+c@x.co.uk"] });
    expect(cleanRecipients(Array.from({ length: 5 }, (_, i) => `u${i}@x.fr`)).ok).toBe(true);
    expect(cleanRecipients(Array.from({ length: 6 }, (_, i) => `u${i}@x.fr`))).toEqual({ ok: false, error: "au plus 5 destinataires" });
  });

  it("refuses invalid addresses and anything that could add a recipient or a header", () => {
    for (const bad of [
      [], "a@x.fr", null, [""], ["pas-une-adresse"], ["a@x"], ["a@@x.fr"], ["a b@x.fr"], ["a@x.fr, b@y.fr"], ["a@x.fr;b@y.fr"],
      ["Nom <a@x.fr>"], ["a@x.fr\nBcc: b@y.fr"], ["a@x.fr\r\nb@y.fr"], ["\"a\"@x.fr"], ["a@x..fr"], ["a..b@x.fr"], ["a@-x.fr"], [3], [["a@x.fr"]],
      [`${"a".repeat(65)}@x.fr`],
    ]) expect(cleanRecipients(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it("keeps a subject on one line", () => {
    expect(cleanSubject("Bilan\r\nBcc: x@y.fr\t du   jour ")).toBe("Bilan Bcc: x@y.fr du jour");
    expect(cleanSubject("x".repeat(300))).toHaveLength(200);
  });

  it("reads the e-mail webhook from its own variable only", () => {
    expect(routinesWebhook({})).toBeNull();
    expect(routinesWebhook({ N8N_ALERT_WEBHOOK_URL: "https://n8n.test/webhook/impulsemotion-alerts" })).toBeNull();
    expect(routinesWebhook({ N8N_ROUTINES_WEBHOOK_URL: "http://n8n.test/x" })).toBeNull();
    expect(routinesWebhook({ N8N_ROUTINES_WEBHOOK_URL: EMAIL_URL, N8N_ALERT_WEBHOOK_SECRET: "s" })).toEqual({ url: EMAIL_URL, secret: "s" });
  });
});

describe("notify — text", () => {
  it("renders the rows as an aligned table, numbers to the right", () => {
    expect(renderTable(campaigns(2))).toBe([
      "campagne     spend   cpa",
      "----------  ------  ----",
      "Campagne 1  100.46  12.5",
      "Campagne 2  101.46",
    ].join("\n"));
    expect(renderTable(null)).toBe("");
    expect(renderTable({ columns: ["a"], rows: [], truncated: false })).toBe("");
  });

  it("cuts the table on a row and counts what is left out", () => {
    const byRows = renderTable(campaigns(30), { maxRows: 5 }).split("\n");
    expect(byRows).toHaveLength(8);
    expect(byRows.at(-1)).toBe("… 25 lignes de plus");
    const byChars = renderTable(campaigns(30), { maxChars: 300 });
    expect(byChars.length).toBeLessThanOrEqual(300);
    expect(byChars.split("\n").at(-1)).toMatch(/^… \d+ lignes de plus$/);
    for (const line of byChars.split("\n").slice(2, -1)) expect(line).toMatch(/^Campagne \d+ +\d+\.\d+/);
    const wide: RowSet = { columns: Array.from({ length: 11 }, (_, i) => `c${i}`), rows: [Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`c${i}`, i]))], truncated: true };
    expect(renderTable(wide).split("\n").at(-1)).toBe("… la source contient d'autres lignes, 3 colonnes non affichées");
  });

  it("cuts a long text cleanly and says so", () => {
    const long = Array.from({ length: 200 }, (_, i) => `ligne ${i}`).join("\n");
    const cut = truncateText(long, 500);
    expect(cut.length).toBeLessThanOrEqual(500);
    expect(cut.endsWith("\n… (message tronqué)")).toBe(true);
    expect(cut.split("\n").at(-2)).toMatch(/^ligne \d+$/);
    expect(truncateText("court", 500)).toBe("court");
  });

  it("does not let a cell ring a channel", () => {
    expect(defuseSlack("Alerte <!channel> <!here> <@U123ABC> <!subteam^S1> et <#C0123ABCD>")).toBe("Alerte &lt;!channel> &lt;!here> &lt;@U123ABC> &lt;!subteam^S1> et &lt;#C0123ABCD>");
  });

  // The test used to say that « <https://x.fr|lien> » went through as it was: defect 9 of the review.
  it("writes out a link hidden under a text: the address is read, it is no longer clicked under other words", () => {
    expect(defuseSlack("Bravo <https://evil.example/login|Valider le budget> !")).toBe("Bravo Valider le budget (https://evil.example/login) !");
    expect(defuseSlack("<https://x.fr|lien> et <HTTPS://y.fr/a?b=1|autre>")).toBe("lien (https://x.fr) et autre (HTTPS://y.fr/a?b=1)");
    expect(defuseSlack("<mailto:a@b.fr|écrire> <https://x.fr> <https://x.fr|>")).toBe("écrire (mailto:a@b.fr) https://x.fr https://x.fr");
    // A label that holds a mention, a sequence left open: nothing of Slack's syntax is left to read.
    for (const hostile of ["<https://evil.example|<!channel>>", "<https://evil.example|clic", "<javascript:alert(1)|clic>", "<slack://open|ici>", "<#C0123ABCD|général>"]) {
      expect(defuseSlack(hostile), hostile).not.toMatch(/<(?:[!@#]|[a-z][a-z0-9+.-]*:)/i);
    }
    // Defusing twice changes nothing more, and a plain « < » stays.
    const once = defuseSlack("a < b, <https://x.fr|lien>, 3 <4");
    expect(once).toBe("a < b, lien (https://x.fr), 3 <4");
    expect(defuseSlack(once)).toBe(once);
  });
});

describe("notify — senders", () => {
  it("refuse to send without a guard minted by the engine, before any call", async () => {
    const fakes = [null, undefined, {}, { runId: "run1" }, { ...live() }] as unknown as WriteGuard[];
    for (const fake of fakes) {
      await expect(sendEmail(fake, { to: ["a@x.fr"], subject: "s", text: "t" })).rejects.toThrow(/Écriture refusée/);
      await expect(sendSlackMessage(fake, { channel: "#c_lpev", text: "t", routine })).rejects.toThrow(/Écriture refusée/);
    }
    expect(sent).toEqual([]);
  });

  it("send the e-mail with the agreed payload and the secret in a header", async () => {
    await sendEmail(live(), { to: ["A@x.fr"], subject: "Bilan\ndu jour", text: "Bonjour" });
    expect(sent).toEqual([{
      url: EMAIL_URL,
      headers: { "Content-Type": "application/json", "X-Alert-Secret": "secret-routines" },
      body: { version: 1, kind: "email", to: ["a@x.fr"], subject: "Bilan du jour", text: "Bonjour" },
    }]);
  });

  it("class what n8n answers", async () => {
    answer = { status: 401, json: { ok: false, error: "unauthorized" } };
    await expect(sendEmail(live(), { to: ["a@x.fr"], subject: "s", text: "t" })).rejects.toMatchObject({ errorClass: "functional" });
    answer = { status: 200, json: { ok: false, error: "gmail_error" } };
    await expect(sendEmail(live(), { to: ["a@x.fr"], subject: "s", text: "t" })).rejects.toMatchObject({ errorClass: "infra", message: expect.stringContaining("gmail_error") });
    answer = { status: 503, json: {} };
    await expect(sendEmail(live(), { to: ["a@x.fr"], subject: "s", text: "t" })).rejects.toMatchObject({ errorClass: "infra" });
    answer = "down";
    await expect(sendEmail(live(), { to: ["a@x.fr"], subject: "s", text: "t" })).rejects.toMatchObject({ errorClass: "infra" });

    answer = { status: 200, json: { ok: false, error: "channel_not_found" } };
    await expect(sendSlackMessage(live(), { channel: "#c_absent", text: "t", routine })).rejects.toMatchObject({ errorClass: "functional", message: expect.stringContaining("#c_absent") });
    answer = { status: 502, json: {} };
    await expect(sendSlackMessage(live(), { channel: "#c_lpev", text: "t", routine })).rejects.toMatchObject({ errorClass: "infra" });
  });

  it("refuse invalid destinations even with a guard", async () => {
    await expect(sendSlackMessage(live(), { channel: "@melvin", text: "t", routine })).rejects.toMatchObject({ errorClass: "functional" });
    await expect(sendEmail(live(), { to: ["a@x.fr\nBcc: b@y.fr"], subject: "s", text: "t" })).rejects.toMatchObject({ errorClass: "functional" });
    await expect(sendEmail(live(), { to: Array.from({ length: 6 }, (_, i) => `u${i}@x.fr`), subject: "s", text: "t" })).rejects.toMatchObject({ errorClass: "functional" });
    expect(sent).toEqual([]);
  });
});

describe("slack.message", () => {
  const step: SlackMessageStep = { id: "slack", type: "slack.message", channel: "#c_lpev", text: "Bilan du {{run.date}} : {{steps.resume.text}}", includeTable: true };

  it("validates the shape and stores the channel in its clean form", () => {
    expect(slackMessageHandler.validate({ ...step, channel: "c_lpev" })).toEqual({ ok: true, step });
    for (const bad of [
      { ...step, channel: "@melvin" }, { ...step, channel: "#Pas Valide" }, { ...step, channel: "https://hooks.slack.com/x" }, { ...step, channel: ["#c_lpev"] },
      { ...step, text: "" }, { ...step, text: "{{row.a | json}}" }, { ...step, text: "{{secrets.token}}" }, { ...step, text: "x".repeat(3001) },
      { ...step, includeTable: "oui" }, { ...step, perRow: true }, { ...step, webhookUrl: "https://x" },
    ]) expect(slackMessageHandler.validate(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it("is refused at preflight when Slack delivery is not configured", async () => {
    expect(await slackMessageHandler.preflight(step, routine)).toEqual([]);
    vi.stubEnv("N8N_AUTO_ALERT_WEBHOOK_URL", "");
    vi.stubEnv("N8N_ALERT_WEBHOOK_URL", "");
    expect(await slackMessageHandler.preflight(step, routine)).toEqual([{ stepId: "slack", severity: "error", message: expect.stringContaining("envoi Slack non configuré") }]);
    expect(await slackMessageHandler.run(step, context(campaigns(2), live()))).toMatchObject({ status: "failed", error: { class: "functional" } });
    expect(sent).toEqual([]);
  });

  it("dry run: sends nothing and shows the message", async () => {
    const out = await slackMessageHandler.run(step, context(campaigns(2), null, { resume: { text: "tout va bien" } }));
    expect(out).toMatchObject({ status: "ok", rowsIn: 2, rowsOut: 0, written: [] });
    expect(out.planned).toEqual([{
      target: "slack", summary: "Message Slack dans #c_lpev",
      preview: { channel: "#c_lpev", text: "Bilan du 2026-09-29 : tout va bien\n\n```\ncampagne     spend   cpa\n----------  ------  ----\nCampagne 1  100.46  12.5\nCampagne 2  101.46\n```" },
    }]);
    expect(sent).toEqual([]);
  });

  it("live: ONE message for the whole run, whatever the number of rows", async () => {
    const out = await slackMessageHandler.run({ ...step, text: "{{row.campagne}} en tête" }, context(campaigns(40), live()));
    expect(out).toMatchObject({ status: "ok", rowsIn: 40, rowsOut: 1, written: [{ summary: "Message Slack dans #c_lpev" }] });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(SLACK_URL);
    expect(sent[0].body).toMatchObject({ version: 1, kind: "digest", channel: "#c_lpev" });
    const text = String(sent[0].body.text);
    expect(text.startsWith("Campagne 1 en tête\n\n```\n")).toBe(true);
    expect(text).toContain("… 20 lignes de plus");
    expect(text.length).toBeLessThanOrEqual(MAX_SLACK_CHARS);
    expect(out.warnings.join(" ")).toContain("première des 40 lignes");
    expect(out.output.rows?.rows).toHaveLength(40);
  });

  it("sends nothing when there are no rows to speak of", async () => {
    const empty: RowSet = { columns: ["campagne"], rows: [], truncated: false };
    for (const input of [empty, null]) {
      const out = await slackMessageHandler.run(step, context(input, live(), { resume: { text: "x" } }));
      expect(out).toMatchObject({ status: "skipped", rowsOut: 0, planned: [], written: [] });
      expect(out.warnings[0]).toContain("message non envoyé");
    }
    expect(sent).toEqual([]);
    // Rows were expected and none came: a message without table would announce work that was not done.
    const afterNothing = await slackMessageHandler.run({ ...step, includeTable: false }, context(empty, live(), { resume: { text: "rien à signaler" } }));
    expect(afterNothing).toMatchObject({ status: "skipped", written: [] });
    expect(sent).toEqual([]);
    // No source above the message: it leaves at every run.
    const textOnly = await slackMessageHandler.run({ ...step, includeTable: false }, context(null, live(), { resume: { text: "rien à signaler" } }));
    expect(textOnly.status).toBe("ok");
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toBe("Bilan du 2026-09-29 : rien à signaler");
  });

  it("fails on a column that the rows do not hold, and defuses mentions coming from a cell", async () => {
    const missing = await slackMessageHandler.run({ ...step, text: "{{row.absente}}" }, context(campaigns(1), live()));
    expect(missing).toMatchObject({ status: "failed", error: { class: "functional", message: expect.stringContaining("« absente »") } });
    expect(sent).toEqual([]);
    const rows: RowSet = { columns: ["nom"], truncated: false, rows: [{ nom: "<!channel> urgent ```" }] };
    await slackMessageHandler.run({ ...step, text: "{{row.nom}}" }, context(rows, live()));
    const text = String(sent[0].body.text);
    expect(text).not.toContain("<!channel>");
    expect(text.match(/```/g)).toHaveLength(3);
  });

  it("reports a refused channel as a functional failure, an outage as infra", async () => {
    answer = { status: 200, json: { ok: false, error: "not_in_channel" } };
    expect(await slackMessageHandler.run(step, context(campaigns(1), live(), { resume: { text: "x" } }))).toMatchObject({ status: "failed", written: [], error: { class: "functional" } });
    answer = "down";
    expect(await slackMessageHandler.run(step, context(campaigns(1), live(), { resume: { text: "x" } }))).toMatchObject({ status: "failed", written: [], error: { class: "infra" } });
  });
});

describe("email.send", () => {
  const step: EmailSendStep = { id: "mail", type: "email.send", to: ["melvin@impulse-analytics.com"], subject: "Bilan {{run.date}}", body: "Bonjour,\n{{steps.resume.text}}", includeTable: true };

  it("validates the shape", () => {
    expect(emailSendHandler.validate({ ...step, to: [" Melvin@impulse-analytics.com"] })).toEqual({ ok: true, step });
    for (const bad of [
      { ...step, to: [] }, { ...step, to: "melvin@impulse-analytics.com" }, { ...step, to: ["pas-une-adresse"] }, { ...step, to: ["a@x.fr, b@y.fr"] },
      { ...step, to: Array.from({ length: 6 }, (_, i) => `u${i}@x.fr`) },
      { ...step, subject: "" }, { ...step, subject: "a\nBcc: x@y.fr" }, { ...step, subject: "{{row.a.b | x}}" }, { ...step, body: "" }, { ...step, body: "x".repeat(5001) },
      { ...step, cc: ["a@x.fr"] }, { ...step, bcc: ["a@x.fr"] }, { ...step, html: "<b>x</b>" },
    ]) expect(emailSendHandler.validate(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it("without the webhook variable: refused at preflight, and fails functionally in a dry run too", async () => {
    expect(await emailSendHandler.preflight(step, routine)).toEqual([]);
    vi.stubEnv("N8N_ROUTINES_WEBHOOK_URL", "");
    expect(await emailSendHandler.preflight(step, routine)).toEqual([{ stepId: "mail", severity: "error", message: EMAIL_NOT_CONFIGURED }]);
    expect(EMAIL_NOT_CONFIGURED).toContain("envoi d'e-mail non configuré");
    for (const write of [null, live()]) {
      const out = await emailSendHandler.run(step, context(campaigns(1), write, { resume: { text: "x" } }));
      expect(out).toMatchObject({ status: "failed", planned: [], written: [], error: { class: "functional", message: EMAIL_NOT_CONFIGURED } });
    }
    expect(sent).toEqual([]);
  });

  it("dry run: sends nothing and shows the e-mail", async () => {
    const out = await emailSendHandler.run(step, context(campaigns(1), null, { resume: { text: "tout va bien" } }));
    expect(out).toMatchObject({ status: "ok", rowsOut: 0, written: [] });
    expect(out.planned).toEqual([{
      target: "email", summary: "E-mail à melvin@impulse-analytics.com",
      preview: { to: "melvin@impulse-analytics.com", subject: "Bilan 2026-09-29", text: "Bonjour,\ntout va bien\n\ncampagne     spend   cpa\n----------  ------  ----\nCampagne 1  100.46  12.5" },
    }]);
    expect(sent).toEqual([]);
  });

  it("live: one e-mail per run with the agreed payload", async () => {
    const out = await emailSendHandler.run({ ...step, includeTable: false, subject: "{{row.campagne}} " }, context(campaigns(12), live(), { resume: { text: "ok" } }));
    expect(out).toMatchObject({ status: "ok", rowsOut: 1, written: [{ summary: "E-mail à melvin@impulse-analytics.com" }] });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(EMAIL_URL);
    expect(Object.keys(sent[0].body).sort()).toEqual(["kind", "subject", "text", "to", "version"]);
    expect(sent[0].body).toMatchObject({ version: 1, kind: "email", to: ["melvin@impulse-analytics.com"], text: "Bonjour,\nok" });
  });

  it("a subject built from a cell stays on one line", async () => {
    const rows: RowSet = { columns: ["nom"], truncated: false, rows: [{ nom: "Promo\r\nBcc: pirate@x.fr" }] };
    await emailSendHandler.run({ ...step, includeTable: false, subject: "Créa {{row.nom}}", body: "x" }, context(rows, live()));
    expect(sent[0].body.subject).toBe("Créa Promo Bcc: pirate@x.fr");
    expect(sent[0].body.to).toEqual(["melvin@impulse-analytics.com"]);
  });

  it("reports a refusal of n8n without claiming a send", async () => {
    answer = { status: 404, json: { message: "webhook not registered" } };
    expect(await emailSendHandler.run(step, context(campaigns(1), live(), { resume: { text: "x" } }))).toMatchObject({ status: "failed", written: [], error: { class: "functional" } });
    answer = "down";
    expect(await emailSendHandler.run(step, context(campaigns(1), live(), { resume: { text: "x" } }))).toMatchObject({ status: "failed", written: [], error: { class: "infra" } });
  });
});
