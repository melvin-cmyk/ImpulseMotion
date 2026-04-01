/**
 * GET /api/deck/clients
 * Returns real clients from Meta Ads (direct Graph API) + Google Ads (via relay MCP).
 * Meta accounts are fetched directly from the Graph API using the session token — fast (~1s).
 * Google Ads accounts use the relay MCP — slower, fetched in parallel and optional.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getAdAccounts } from "@/lib/meta-api";

const rawRelayUrl = (process.env.NEXT_PUBLIC_RELAY_URL || "").trim();
const RELAY_URL = rawRelayUrl
  ? rawRelayUrl.startsWith("http") ? rawRelayUrl : `https://${rawRelayUrl}`
  : "http://localhost:3457";

// Server-side: try localhost first (direct), then configured tunnel URL
const RELAY_URLS = RELAY_URL.includes("localhost")
  ? [RELAY_URL]
  : ["http://localhost:3457", RELAY_URL];

export interface DeckClientResult {
  id: string;
  name: string;
  platform: "meta" | "google" | "both";
  metaAccountId?: string;
  googleCustomerId?: string;
}

let clientCache: { data: { clients: DeckClientResult[] }; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Call the relay for Google Ads customers list — optional, times out gracefully */
async function fetchGoogleCustomers(timeoutMs = 40000): Promise<Array<{ id?: string; name?: string }>> {
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{
            role: "user",
            content: `Call mcp__mcp-google-ads__List_Customers with no params. Return ONLY the raw JSON tool result.`,
          }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;

      const reader = res.body?.getReader();
      if (!reader) continue;

      const decoder = new TextDecoder();
      let fullText = "";
      let toolResultText = ""; // Raw MCP tool output — more reliable
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const event = JSON.parse(data);
            // tool_result — raw MCP output (highest priority)
            if (event.type === "tool_result" && typeof event.content === "string") { toolResultText += event.content; continue; }
            if (event.type === "delta" && typeof event.text === "string") { fullText += event.text; continue; }
            if (event.type === "content" && typeof event.text === "string") { fullText = event.text; continue; }
            if (event.type === "content" && typeof event.content === "string") { fullText = event.content; continue; }
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") { fullText += event.delta.text; continue; }
            if (event.choices?.[0]?.delta?.content) { fullText += event.choices[0].delta.content; continue; }
          } catch { /* skip */ }
        }
      }

      // Prefer raw tool result over AI-formatted text
      const textToParse = toolResultText.trim() || fullText.trim();
      if (!textToParse) continue;

      console.log(`[deck/clients] google raw (${toolResultText ? "tool_result" : "fullText"}):`, textToParse.slice(0, 300));

      // Try to extract customers from various formats:
      // 1. GAQL format: [{"customer.id":"...","customer.descriptive_name":"..."}]
      // 2. Simplified: [{"id":"...","name":"..."}]
      // 3. Nested: {"results":[...]}
      const stripped = textToParse.replace(/```(?:json)?\n?([\s\S]*?)\n?```/g, "$1").trim();
      for (const candidate of [stripped, textToParse]) {
        // Try object with results array
        const objMatch = candidate.match(/\{[\s\S]*\}/);
        if (objMatch) {
          try {
            const obj = JSON.parse(objMatch[0]) as Record<string, unknown>;
            const arr = (obj.results || obj.customers || obj.data) as unknown[] | undefined;
            if (Array.isArray(arr)) {
              return arr.map((r) => {
                const row = r as Record<string, unknown>;
                const id = (row["customer.id"] || row["customer_id"] || row["id"] || "") as string;
                const name = (row["customer.descriptive_name"] || row["customer_name"] || row["name"] || id) as string;
                return { id: id.replace(/-/g, ""), name };
              });
            }
          } catch { /* try array */ }
        }
        // Try direct array
        const arrMatch = candidate.match(/\[[\s\S]*\]/);
        if (!arrMatch) continue;
        try {
          const parsed = JSON.parse(arrMatch[0]) as unknown[];
          if (Array.isArray(parsed)) {
            return parsed.map((r) => {
              const row = r as Record<string, unknown>;
              const id = (row["customer.id"] || row["customer_id"] || row["id"] || "") as string;
              const name = (row["customer.descriptive_name"] || row["customer_name"] || row["name"] || id) as string;
              return { id: id.replace(/-/g, ""), name };
            });
          }
        } catch { /* try next candidate */ }
      }
    } catch (e) {
      console.log("[deck/clients] google relay error:", String(e));
    }
  }
  return [];
}

export async function GET() {
  // Return cached result if still fresh
  if (clientCache && Date.now() - clientCache.ts < CACHE_TTL) {
    console.log("[deck/clients] serving from cache");
    return NextResponse.json(clientCache.data);
  }

  const session = await auth();
  const metaToken = (session as { metaAccessToken?: string | null } | null)?.metaAccessToken;

  // No session at all → user needs to log in
  if (!session) {
    return NextResponse.json({ clients: [], needsAuth: true, reason: "no_session" });
  }

  // Session exists but no Meta token → user needs to reconnect Meta
  if (!metaToken) {
    return NextResponse.json({ clients: [], needsAuth: true, reason: "no_meta_token" });
  }

  // Fetch Meta accounts directly (fast, ~1s) + Google via relay in parallel
  const [metaAccounts, googleRaw] = await Promise.all([
    getAdAccounts(metaToken).catch((e) => {
      console.log("[deck/clients] Meta direct API error:", String(e));
      return [];
    }),
    fetchGoogleCustomers(40000),
  ]);

  console.log(`[deck/clients] Meta: ${metaAccounts.length} accounts, Google: ${googleRaw.length} customers`);

  const clients: DeckClientResult[] = metaAccounts.map((acc) => ({
    id: `meta-${acc.id}`,
    name: acc.name || acc.id,
    platform: "meta" as const,
    metaAccountId: acc.id,
  }));

  // Merge Google: if same name exists in Meta, mark as "both"
  for (const item of googleRaw) {
    const name = (item.name || item.id || "Google Ads Account") as string;
    const existing = clients.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.platform = "both";
      existing.googleCustomerId = item.id;
    } else {
      clients.push({
        id: `google-${item.id || Math.random()}`,
        name,
        platform: "google",
        googleCustomerId: item.id,
      });
    }
  }

  // Store result in cache
  clientCache = { data: { clients }, ts: Date.now() };

  return NextResponse.json({ clients });
}
