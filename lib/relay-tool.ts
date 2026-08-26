/**
 * Server-side helper to call a single MCP tool through the relay's /api/tool
 * endpoint. Bypasses the AI loop, so it's fast (~1-2s) when you just want
 * raw structured data from Google Ads or another MCP server.
 */

import { relayHeaders } from "@/lib/relay-headers";
import { RELAY_URLS } from "@/lib/relay-server";

export async function relayDirectTool(
  tool: string,
  input: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<unknown> {
  let lastError: Error | null = null;
  for (const url of RELAY_URLS) {
    const isLocalhost = url.includes("localhost");
    const actualTimeout = isLocalhost ? Math.min(timeoutMs, 2000) : timeoutMs;
    try {
      const res = await fetch(`${url}/api/tool`, {
        method: "POST",
        headers: relayHeaders(),
        body: JSON.stringify({ tool, input, timeoutMs }),
        signal: AbortSignal.timeout(actualTimeout),
      });
      if (!res.ok) {
        lastError = new Error(`Relay ${url} /api/tool ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { result?: unknown; error?: string };
      if (json.error) {
        lastError = new Error(json.error);
        continue;
      }
      return json.result;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error("Relay unreachable");
}
