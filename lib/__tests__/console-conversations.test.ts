import { describe, expect, it } from "vitest";
import { conversationTitle, isConversationId, sanitizeConsoleMessages } from "@/lib/console-conversations";

describe("console conversations", () => {
  it("accepts uuids only as conversation ids", () => {
    expect(isConversationId("3f2b8c1e-5d4a-4f6b-9c7d-1a2b3c4d5e6f")).toBe(true);
    expect(isConversationId("../other")).toBe(false);
    expect(isConversationId(42)).toBe(false);
  });

  it("drops image pixels, tool outputs and unknown fields", () => {
    const out = sanitizeConsoleMessages([
      { id: "a", role: "user", content: "Bilan LPEV", images: [{ mediaType: "image/png", data: "AAAA", name: "x.png" }], secret: "nope" },
      { id: "b", role: "assistant", content: "Voici", toolCalls: [{ name: "mcp__hq__search", id: "t1", input: { q: "x" } }], toolResults: [{ id: "t1", content: "données", is_error: false }], activity: { phase: "running" }, isStreaming: true },
      { id: "c", role: "system", content: "ignored" },
      { id: "d", role: "assistant", content: "" },
    ]);
    expect(out).toHaveLength(2);
    expect(out![0].images).toEqual([{ mediaType: "image/png", data: "", name: "x.png" }]);
    expect(out![0]).not.toHaveProperty("secret");
    expect(out![1].toolCalls).toEqual([{ name: "mcp__hq__search", id: "t1" }]);
    expect(out![1].toolResults).toEqual([{ id: "t1", content: "", is_error: false }]);
    expect(out![1]).not.toHaveProperty("activity");
  });

  it("rejects what is not a list and titles from the first question", () => {
    expect(sanitizeConsoleMessages({})).toBeNull();
    const msgs = sanitizeConsoleMessages([{ id: "a", role: "user", content: "Analyse Meta\n\n[Fichiers déposés dans /work/uploads : a.xlsx]" }])!;
    expect(conversationTitle(msgs)).toBe("Analyse Meta");
    expect(conversationTitle([])).toBe("Nouvelle conversation");
  });
});
