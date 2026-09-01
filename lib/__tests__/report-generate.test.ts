import { describe, expect, it } from "vitest";
import { parseReportOutput, resolveCompare, shiftYear } from "@/lib/report-generate";
import { periodLabel, lastMonthRange, lastWeekRange } from "@/lib/report-data";

const SAMPLE = `## Synthèse
- Le compte dépense plus pour un revenu stable.
- Google porte les conversions.

## Performance globale
| Métrique | Valeur |
|---|---|
| Dépenses | 6 571 € |

## Campagnes
Texte.

\`\`\`nextsteps
[
  { "title": "Auditer le tracking Meta", "detail": "3 conversions pour 2 603 €", "priority": "high", "platform": "meta" },
  { "title": "Réallouer le budget", "detail": "vers Brand", "priority": "banana", "platform": "mars" }
]
\`\`\``;

describe("parseReportOutput", () => {
  it("splits markdown, summary and next steps", () => {
    const r = parseReportOutput(SAMPLE);
    expect(r.contentMd.startsWith("## Synthèse")).toBe(true);
    expect(r.contentMd).not.toContain("nextsteps");
    expect(r.summary).toContain("Google porte les conversions");
    expect(r.nextSteps).toHaveLength(2);
    expect(r.nextSteps[0]).toMatchObject({ id: "ns-1", title: "Auditer le tracking Meta", priority: "high", platform: "meta", done: false });
    // invalid enum values fall back
    expect(r.nextSteps[1].priority).toBe("medium");
    expect(r.nextSteps[1].platform).toBe("global");
  });

  it("tolerates a json fence and a stray H1", () => {
    const r = parseReportOutput(`# Rapport\n## Synthèse\n- ok\n\n\`\`\`json\n[{"title":"A","detail":"b"}]\n\`\`\``);
    expect(r.contentMd.startsWith("## Synthèse")).toBe(true);
    expect(r.nextSteps).toHaveLength(1);
  });

  it("returns no steps when the fence is missing", () => {
    const r = parseReportOutput("## Synthèse\n- rien");
    expect(r.nextSteps).toEqual([]);
    expect(r.contentMd).toBe("## Synthèse\n- rien");
  });
});

describe("resolveCompare", () => {
  it("prev = previous window of equal length", () => {
    expect(resolveCompare("2026-08-01", "2026-08-31", "prev")).toEqual({ since: "2026-07-01", until: "2026-07-31" });
  });
  it("year shifts one year back, clamping Feb 29", () => {
    expect(resolveCompare("2026-08-01", "2026-08-31", "year")).toEqual({ since: "2025-08-01", until: "2025-08-31" });
    expect(shiftYear("2024-02-29")).toBe("2023-02-28");
  });
  it("none disables, custom passes through, unknown falls back to prev", () => {
    expect(resolveCompare("2026-08-01", "2026-08-31", "none")).toBeNull();
    expect(resolveCompare("2026-08-01", "2026-08-31", "custom", { since: "2026-01-01", until: "2026-01-31" })).toEqual({ since: "2026-01-01", until: "2026-01-31" });
    expect(resolveCompare("2026-08-01", "2026-08-31", "whatever")).toEqual({ since: "2026-07-01", until: "2026-07-31" });
  });
});

describe("period helpers", () => {
  it("labels a full month and a free range", () => {
    expect(periodLabel("2026-08-01", "2026-08-31")).toBe("Août 2026");
    expect(periodLabel("2026-08-01", "2026-08-30")).toContain("→");
  });
  it("computes last month / last week in UTC", () => {
    expect(lastMonthRange(new Date("2026-09-01T07:00:00Z"))).toEqual({ since: "2026-08-01", until: "2026-08-31" });
    expect(lastWeekRange(new Date("2026-08-31T07:00:00Z"))).toEqual({ since: "2026-08-24", until: "2026-08-30" });
  });
});
