import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { teeRelayStream } from "@/lib/relay-chat";
import type { RelayUsage } from "@/lib/ai-usage";

const enc = new TextEncoder();
const sse = (e: Record<string, unknown>) => enc.encode(`data: ${JSON.stringify(e)}\n\n`);
const usage = (output: number, partial: boolean) => ({
  type: "usage", partial, provider: "subscription", model: "claude-fable-5-1", effort: "medium",
  cost: 0, turns: 1, duration: 1000, tokens: { input: 10, output, cacheRead: 100, cacheWrite: 50 },
});

function source(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(sse(e));
      controller.close();
    },
  });
}

async function run(events: Array<Record<string, unknown>>) {
  let seen: { sawDone: boolean; usage: RelayUsage | null } | null = null;
  const out = teeRelayStream(source(events), (_t, sawDone, u) => { seen = { sawDone, usage: u }; });
  const reader = out.getReader();
  while (!(await reader.read()).done) { /* drain */ }
  return seen as { sawDone: boolean; usage: RelayUsage | null } | null;
}

describe("usage of a cut turn", () => {
  it("records the running total when the turn never reaches its final usage", async () => {
    const seen = await run([usage(200, true), usage(900, true), { type: "error", message: "Temps de session dépassé", resumable: true }, { type: "done" }]);
    expect(seen?.usage?.outputTokens).toBe(900);
    expect(seen?.usage?.cacheReadTokens).toBe(100);
  });

  it("lets the final usage replace the running totals", async () => {
    const seen = await run([usage(200, true), usage(1500, false), { type: "done" }]);
    expect(seen?.usage?.outputTokens).toBe(1500);
    expect(seen?.sawDone).toBe(true);
  });
});
