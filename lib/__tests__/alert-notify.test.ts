import { describe, expect, it } from "vitest";
import { buildAlertPayload, hasNotifyTargets, parseNotify, validateNotify } from "@/lib/alert-notify";

describe("validateNotify", () => {
  it("accepts a channel name or id and a short e-mail list", () => {
    expect(validateNotify({ slackChannel: "#alertes-lpev", emails: "a@x.fr, B@Y.com" })).toEqual({ ok: true, value: { slackChannel: "#alertes-lpev", emails: ["a@x.fr", "b@y.com"] } });
    expect(validateNotify({ slackChannel: "C0123ABCDE" })).toEqual({ ok: true, value: { slackChannel: "C0123ABCDE" } });
    expect(validateNotify(undefined)).toEqual({ ok: true, value: {} });
    expect(validateNotify({ slackChannel: "", emails: [] })).toEqual({ ok: true, value: {} });
  });
  it("rejects bad channels, bad e-mails and too many recipients", () => {
    expect(validateNotify({ slackChannel: "alertes" }).ok).toBe(false);
    expect(validateNotify({ emails: ["not-an-email"] }).ok).toBe(false);
    expect(validateNotify({ emails: Array.from({ length: 6 }, (_, i) => `u${i}@x.fr`) }).ok).toBe(false);
    expect(validateNotify("x").ok).toBe(false);
  });
  it("parseNotify never throws and hasNotifyTargets reads it", () => {
    expect(parseNotify("{bad")).toEqual({});
    expect(hasNotifyTargets(parseNotify('{"emails":["a@b.fr"]}'))).toBe(true);
    expect(hasNotifyTargets(parseNotify("{}"))).toBe(false);
  });
});

describe("buildAlertPayload", () => {
  it("produces the version-1 contract n8n expects", () => {
    const p = buildAlertPayload(
      {
        id: "ev1", triggeredAt: new Date("2026-09-22T08:00:00Z"), metric: "roas", value: 1.4, threshold: 2, message: "ROAS = 1.4 (seuil 2)", clientId: "act_1",
        rule: { id: "r1", condition: "below", window: "7d", platform: "meta", notifyJson: "{}", user: { email: "c@impulse.fr", name: "Consultante" } },
      },
      { slackChannel: "#alertes", emails: ["c@impulse.fr"] },
      "LPEV — Meta",
      "https://app.test",
    );
    expect(p.version).toBe(1);
    expect(p.event).toMatchObject({ id: "ev1", metric: "roas", condition: "below", accountLabel: "LPEV — Meta", window: "7d" });
    expect(p.notify).toEqual({ slackChannel: "#alertes", emails: ["c@impulse.fr"] });
    expect(p.links.event).toBe("https://app.test/admin/alerts?event=ev1");
  });
});
