import { describe, expect, it } from "vitest";
import { INITIAL_ACTIVITY, reduceActivity, type ActivityState } from "@/lib/ai-activity";
import { MO_STATUS, moStatusLabel, toolStatusKey } from "@/lib/mo/status";

const running = (tool: string): ActivityState => reduceActivity(INITIAL_ACTIVITY, { type: "tool_call", name: tool, id: "1" });

describe("Mo — what it says it is doing", () => {
  it("maps the tools to actions", () => {
    expect(toolStatusKey("mcp__mo__creatives")).toBe("warehouse");
    expect(toolStatusKey("mcp__mo__metrics")).toBe("warehouse");
    expect(toolStatusKey("mcp__mo__creative_metrics")).toBe("warehouse");
    expect(toolStatusKey("mcp__mo__competitor_ads")).toBe("library");
    expect(toolStatusKey("mcp__mo__keep_template")).toBe("library");
    expect(toolStatusKey("mcp__mo__generate_creatives")).toBe("generate");
    expect(toolStatusKey("mcp__mo__meta_publish_ad")).toBe("publish");
    expect(toolStatusKey("mcp__mo__meta_targets")).toBe("publish");
    expect(toolStatusKey("mcp__meta-ads-impulse__Get_Campaigns")).toBe("live");
    expect(toolStatusKey("mcp__hq__hq_files_read")).toBe("memory");
    expect(toolStatusKey("ToolSearch")).toBe("think");
    expect(toolStatusKey(null)).toBe("think");
  });
  it("never says « démarrage » nor a raw tool name", () => {
    expect(moStatusLabel(INITIAL_ACTIVITY)).toBe(MO_STATUS.think);
    expect(moStatusLabel(null)).toBe(MO_STATUS.think);
    expect(moStatusLabel(running("mcp__mo__creatives"))).toBe("je cherche dans l'entrepôt");
    expect(moStatusLabel(running("mcp__mo__generate_creatives"))).toBe("je génère les visuels");
    expect(moStatusLabel(running("mcp__mo__competitor_ads"))).toBe("je lis la bibliothèque Meta");
    expect(moStatusLabel(running("mcp__mo__meta_publish_ad"))).toBe("je prépare la publication");
    expect(moStatusLabel(reduceActivity(INITIAL_ACTIVITY, { type: "activity", phase: "tool", name: "mcp__mo__metrics" }))).toBe("je cherche dans l'entrepôt");
    expect(moStatusLabel(reduceActivity(INITIAL_ACTIVITY, { type: "delta" }))).toBe(MO_STATUS.write);
    expect(moStatusLabel(INITIAL_ACTIVITY, "quick")).toBe("je cherche dans l'entrepôt");
    for (const tool of ["mcp__mo__creatives", "WebSearch", "mcp__sandbox__run_python", null]) {
      const label = moStatusLabel(tool ? running(tool) : INITIAL_ACTIVITY);
      expect(label.toLowerCase()).not.toContain("démarrage");
      expect(label).not.toContain("mcp__");
    }
  });
});
