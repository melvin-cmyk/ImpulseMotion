import { describe, expect, it } from "vitest";
import { describeChange } from "@/lib/staff-dashboards/versions";

const before = { title: "A", description: null, datasetsJson: "{}", paramsJson: "{}", html: "<p>a</p>" };

describe("describeChange (versions des dashboards du staff)", () => {
  it("ne nomme rien quand rien ne change (partage seul, ou mêmes valeurs)", () => {
    expect(describeChange(before, {})).toBe("");
    expect(describeChange(before, { title: "A", html: "<p>a</p>" })).toBe("");
  });
  it("nomme chaque champ changé, dans un ordre stable", () => {
    expect(describeChange(before, { html: "<p>b</p>" })).toBe("page");
    expect(describeChange(before, { title: "B", datasetsJson: '{"x":1}', html: "<p>b</p>" })).toBe("titre, jeux de données, page");
    expect(describeChange(before, { description: "d" })).toBe("description");
  });
});
