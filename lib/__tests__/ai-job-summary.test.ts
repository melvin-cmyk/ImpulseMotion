import { describe, expect, it } from "vitest";
import { AiJobSummarizer, answerText, summaryFromRelayState } from "@/lib/ai-job-summary";

const line = (o: Record<string, unknown>) => `data: ${JSON.stringify(o)}`;

describe("AiJobSummarizer — ce qu'une tâche a produit, relu depuis ses événements", () => {
  it("assemble les deltas, garde le dernier usage final et les appels d'outils", () => {
    const s = new AiJobSummarizer();
    for (const l of [
      ": hb",
      line({ type: "init" }),
      line({ type: "tool_call", name: "mcp__meta-ads-impulse__Get_Campaigns", id: "t1", seq: 1 }),
      line({ type: "usage", partial: true, cost: 0.001, provider: "subscription", model: "sonnet", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
      line({ type: "delta", text: "Bon" }),
      line({ type: "delta", text: "jour" }),
      line({ type: "content", text: "Bonjour (doublon)" }),
      line({ type: "usage", cost: 0.002, turns: 2, duration: 1500, provider: "subscription", model: "sonnet", tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }),
      line({ type: "done" }),
    ]) s.line(l);
    const r = s.result();
    expect(r.text).toBe("Bonjour");
    expect(r.sawDone).toBe(true);
    expect(r.usage?.costUsd).toBe(0.002);
    expect(r.usage?.turns).toBe(2);
    expect(r.toolCalls).toEqual([{ name: "mcp__meta-ads-impulse__Get_Campaigns", id: "t1" }]);
    expect(r.error).toBeNull();
  });

  it("prend le texte de `content` quand aucun delta n'est venu, et l'usage partiel faute de final", () => {
    const s = new AiJobSummarizer();
    s.line(line({ type: "usage", partial: true, cost: 0.5, provider: "bedrock", model: "sonnet", tokens: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } }));
    s.line(line({ type: "content", text: "Réponse entière" }));
    s.line(line({ type: "error", message: "coupé", resumable: true }));
    const r = s.result();
    expect(r.text).toBe("Réponse entière");
    expect(r.usage?.costUsd).toBe(0.5);
    expect(r.error).toBe("coupé");
    expect(r.resumable).toBe(true);
    expect(r.sawDone).toBe(false);
  });

  it("ignore les lignes qui ne sont pas du JSON d'événement", () => {
    const s = new AiJobSummarizer();
    s.line("data: {pas du json");
    s.line("event: x");
    s.line("");
    expect(s.result()).toMatchObject({ text: "", sawDone: false, usage: null, toolCalls: [] });
  });
});

describe("summaryFromRelayState — l'état que le relay envoie", () => {
  it("relit texte, usage, outils, erreur ; tolère un état incomplet", () => {
    const r = summaryFromRelayState({ text: "ok", sawDone: true, usage: { type: "usage", cost: 0.1, provider: "subscription", model: "opus", tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }, toolCalls: [{ name: "a", id: "1" }, null], error: "", resumable: false });
    expect(r).toMatchObject({ text: "ok", sawDone: true, toolCalls: [{ name: "a", id: "1" }], error: null });
    expect(r.usage?.cacheReadTokens).toBe(3);
    expect(summaryFromRelayState(null)).toMatchObject({ text: "", sawDone: false, usage: null, toolCalls: [], error: null });
  });
});

describe("answerText — le message assistant enregistré", () => {
  const base = { text: "Voici.", sawDone: true, usage: null, toolCalls: [], error: null, resumable: false };
  it("texte nu quand la tâche a fini proprement", () => expect(answerText(base, "done")).toBe("Voici."));
  it("note de troncature sans `done` ou avec une erreur", () => {
    expect(answerText({ ...base, sawDone: false }, "done")).toContain("tronquée");
    expect(answerText({ ...base, error: "boum" }, "done")).toContain("tronquée");
  });
  it("note d'arrêt, note de limite de temps", () => {
    expect(answerText(base, "stopped")).toContain("arrêtée");
    expect(answerText({ ...base, sawDone: false, resumable: true }, "done")).toContain("continue");
  });
  it("null sans texte", () => expect(answerText({ ...base, text: "  " }, "done")).toBeNull());
});
