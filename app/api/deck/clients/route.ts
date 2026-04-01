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

/** Read SSE stream from relay and return the final text content */
async function readRelayStream(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let fullText = "";
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
        if (event.type === "delta" && typeof event.text === "string") { fullText += event.text; continue; }
        if (event.type === "content" && typeof event.text === "string") { fullText = event.text; continue; }
        if (event.type === "content" && typeof event.content === "string") { fullText = event.content; continue; }
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") { fullText += event.delta.text; continue; }
        if (event.choices?.[0]?.delta?.content) { fullText += event.choices[0].delta.content; continue; }
      } catch { /* skip */ }
    }
  }
  return fullText;
}

/** Enrich a single Google customer ID with its descriptive name via GAQL */
async function enrichCustomerName(customerId: string): Promise<string> {
  const cleanId = customerId.replace(/-/g, "");
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{
            role: "user",
            content: `Use mcp__mcp-google-ads__Custom_GAQL_Query on customer ${cleanId} with query: SELECT customer.descriptive_name, customer.id FROM customer LIMIT 1. Return ONLY valid JSON (no markdown): {"name":"...","id":"..."}`,
          }],
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;

      const text = await readRelayStream(res);
      if (!text.trim()) continue;

      const stripped = text.replace(/```(?:json)?\n?([\s\S]*?)\n?```/g, "$1").trim();
      for (const candidate of [stripped, text]) {
        const match = candidate.match(/\{[\s\S]*?\}/);
        if (!match) continue;
        try {
          const parsed = JSON.parse(match[0]);
          if (parsed.name && typeof parsed.name === "string" && parsed.name.trim()) {
            return parsed.name.trim();
          }
        } catch { /* try next */ }
      }
    } catch (e) {
      console.log(`[deck/clients] enrich name ${customerId} error:`, String(e));
    }
  }
  return customerId; // fallback to ID
}

/** Call the relay for Google Ads customers list — optional, times out gracefully */
async function fetchGoogleCustomers(timeoutMs = 40000): Promise<Array<{ id: string; name: string }>> {
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{
            role: "user",
            content: `Call mcp__mcp-google-ads__List_Customers (no params). Return ONLY valid JSON array (no markdown): [{"id":"1234567890","name":""}]`,
          }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;

      const fullText = await readRelayStream(res);
      if (!fullText.trim()) continue;

      // Parse JSON array from response
      const stripped = fullText.replace(/```(?:json)?\n?([\s\S]*?)\n?```/g, "$1").trim();
      let rawList: Array<{ id?: string; name?: string }> = [];
      for (const candidate of [stripped, fullText]) {
        const match = candidate.match(/\[[\s\S]*\]/);
        if (!match) continue;
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) { rawList = parsed; break; }
        } catch { /* try next */ }
      }

      if (!rawList.length) continue;

      // Enrich names in parallel for any customers with empty/missing names
      const enriched = await Promise.allSettled(
        rawList.map(async (item) => {
          const id = (item.id || "").replace(/-/g, "");
          if (!id) return { id: "", name: "Google Ads Account" };
          const hasName = item.name && item.name.trim();
          const name = hasName ? item.name!.trim() : await enrichCustomerName(id);
          return { id, name };
        })
      );

      return enriched
        .filter((r): r is PromiseFulfilledResult<{ id: string; name: string }> => r.status === "fulfilled" && !!r.value.id)
        .map((r) => r.value);
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
    const name = item.name || item.id || "Google Ads Account";
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
