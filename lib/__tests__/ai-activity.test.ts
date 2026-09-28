import { describe, expect, it } from "vitest";
import { INITIAL_ACTIVITY, activityLabel, formatElapsed, formatToolName, reduceActivity, toolAction } from "@/lib/ai-activity";

describe("ai-activity", () => {
  it("follows a turn: thinking → preparing → running → reading results → writing", () => {
    let s = INITIAL_ACTIVITY;
    expect(activityLabel(s)).toBe("Démarrage de la session");
    s = reduceActivity(s, { type: "activity", phase: "thinking" });
    expect(activityLabel(s)).toBe("Réflexion");
    s = reduceActivity(s, { type: "activity", phase: "tool", name: "mcp__sandbox__run_node" });
    expect(activityLabel(s)).toBe("Préparation — Construction du fichier dans le bac à sable");
    s = reduceActivity(s, { type: "tool_call", id: "t1", name: "mcp__sandbox__run_node" });
    expect(s.steps).toBe(1);
    expect(activityLabel(s)).toBe("Construction du fichier dans le bac à sable");
    s = reduceActivity(s, { type: "tool_result", id: "t1" });
    expect(activityLabel(s)).toBe("Analyse des résultats");
    s = reduceActivity(s, { type: "delta" });
    expect(activityLabel(s)).toBe("Rédaction de la réponse");
  });

  it("keeps running while parallel tool calls are pending", () => {
    let s = reduceActivity(INITIAL_ACTIVITY, { type: "tool_call", id: "a", name: "mcp__meta-ads-impulse__Get_Campaigns1" });
    s = reduceActivity(s, { type: "tool_call", id: "b", name: "mcp__mcp-google-ads__Campaigns" });
    s = reduceActivity(s, { type: "tool_result", id: "a" });
    expect(s.phase).toBe("running");
    expect(s.steps).toBe(2);
    s = reduceActivity(s, { type: "tool_result", id: "b" });
    expect(s.phase).toBe("thinking");
  });

  it("ignores unrelated events", () => {
    expect(reduceActivity(INITIAL_ACTIVITY, { type: "usage" })).toBe(INITIAL_ACTIVITY);
    expect(reduceActivity(INITIAL_ACTIVITY, { type: "activity", phase: "tool" })).toBe(INITIAL_ACTIVITY);
  });

  it("labels tools and durations", () => {
    expect(formatToolName("mcp__meta-ads-impulse__Get_Campaigns1")).toBe("Meta : Get_Campaigns");
    expect(formatToolName("WebSearch")).toBe("Recherche web");
    expect(toolAction("mcp__hq__hq_files_read")).toBe("Consultation de HQ");
    expect(toolAction("mcp__sandbox__render_pptx")).toBe("Rendu des pages pour vérification visuelle");
    expect(formatElapsed(45_000)).toBe("45 s");
    expect(formatElapsed(125_000)).toBe("2 min 05");
  });
});
