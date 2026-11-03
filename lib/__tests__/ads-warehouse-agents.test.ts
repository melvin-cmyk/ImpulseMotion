import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/relay-chat", () => ({ relayComplete: vi.fn(), parseLooseJson: vi.fn() }));
import { cleanSections, toRun } from "@/lib/ads-warehouse/agents";
import { AGENT_WORKFLOWS, AGENT_BY_KEY } from "@/lib/ads-warehouse/agents-catalog";

describe("agents catalog", () => {
  it("has unique keys, both scopes", () => {
    expect(new Set(AGENT_WORKFLOWS.map((w) => w.key)).size).toBe(AGENT_WORKFLOWS.length);
    expect(AGENT_WORKFLOWS.some((w) => w.scope === "account")).toBe(true);
    expect(AGENT_WORKFLOWS.some((w) => w.scope === "creative")).toBe(true);
    expect(AGENT_BY_KEY.creative_voice.needsComments).toBe(true);
  });
});

describe("cleanSections", () => {
  it("keeps 1–6 sections with title and body, trimmed and capped", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ title: ` T${i} `, body: "x".repeat(5000) }));
    const out = cleanSections({ sections: many });
    expect(out).toHaveLength(6);
    expect(out[0].title).toBe("T0");
    expect(out[0].body).toHaveLength(3000);
  });
  it("drops empty or malformed sections", () => {
    expect(cleanSections({ sections: [{ title: "", body: "a" }, { title: "a" }, null, "x", { title: "ok", body: "b" }] })).toEqual([{ title: "ok", body: "b" }]);
    expect(cleanSections(null)).toEqual([]);
    expect(cleanSections({ sections: "nope" })).toEqual([]);
  });
});

describe("toRun", () => {
  it("parses JSON columns defensively", () => {
    const r = toRun({ id: "1", workflow: "account_brief", creativeKey: null, label: "", input: "", status: "weird", error: "", sectionsJson: "{bad", scoresJson: '{"0":1}', followupsJson: "[]", createdByName: "", createdAt: new Date("2026-11-03T00:00:00Z") });
    expect(r.status).toBe("error");
    expect(r.sections).toEqual([]);
    expect(r.scores).toEqual({ "0": 1 });
  });
});
