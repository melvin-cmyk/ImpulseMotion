/**
 * GET /api/deck/clients
 * Returns real clients from Meta Ads (direct Graph API) + Google Ads (via relay MCP).
 * Meta accounts are fetched directly from the Graph API using the session token — fast (~1s).
 * Google Ads accounts use the relay MCP — slower, fetched in parallel and optional.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getAdAccounts } from "@/lib/meta-api";

// Server-side: prefer RELAY_URL (server-only), fall back to NEXT_PUBLIC_RELAY_URL, then hardcoded public IP
const rawRelayUrl = (process.env.RELAY_URL || process.env.NEXT_PUBLIC_RELAY_URL || "").trim();
const CONFIGURED_RELAY_URL = rawRelayUrl
  ? rawRelayUrl.startsWith("http") ? rawRelayUrl : `https://${rawRelayUrl}`
  : null;

const RELAY_FALLBACK_URL = "http://72.62.29.196:3457";
const RELAY_URLS = [
  "http://localhost:3457",
  ...(CONFIGURED_RELAY_URL && CONFIGURED_RELAY_URL !== RELAY_FALLBACK_URL ? [CONFIGURED_RELAY_URL] : []),
  RELAY_FALLBACK_URL,
];

export interface DeckClientResult {
  id: string;
  name: string;
  platform: "meta" | "google" | "both";
  metaAccountId?: string;
  googleCustomerId?: string;
}

let clientCache: { data: { clients: DeckClientResult[] }; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Robust relay chat — same logic as data/route.ts, extracts tool_result events preferentially */
async function relayChat(prompt: string, timeoutMs = 60000): Promise<string> {
  let lastError: Error | null = null;
  for (const url of RELAY_URLS) {
    const isLocalhost = url.includes("localhost");
    const actualTimeout = isLocalhost ? Math.min(timeoutMs, 5000) : timeoutMs;
    try {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(actualTimeout),
      });
      if (!res.ok) { lastError = new Error(`Relay ${url} responded ${res.status}`); continue; }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let fullText = "";
      let toolResultText = "";
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
            // Raw MCP tool output — highest priority
            if (event.type === "tool_result" && typeof event.content === "string") { toolResultText += event.content; continue; }
            if (event.type === "delta" && typeof event.text === "string") { fullText += event.text; continue; }
            if (event.type === "content" && typeof event.text === "string") { fullText = event.text; continue; }
            if (event.type === "content" && typeof event.content === "string") { fullText = event.content; continue; }
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") { fullText += event.delta.text; continue; }
            if (event.choices?.[0]?.delta?.content) { fullText += event.choices[0].delta.content; continue; }
            if (event.type === "text" && typeof event.text === "string") { fullText += event.text; continue; }
          } catch { fullText += data; }
        }
      }

      const result = toolResultText.trim() || fullText.trim();
      console.log(`[deck/clients] relay ${url} toolResult=${toolResultText.length}b fullText=${fullText.length}b`);
      if (result) return result;
      lastError = new Error(`Empty response from ${url}`);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.log(`[deck/clients] relay ${url} error:`, String(e));
    }
  }
  throw lastError ?? new Error("All relay URLs failed");
}

function extractJson<T>(text: string): T | null {
  const stripped = text.replace(/```(?:json)?\n?([\s\S]*?)\n?```/g, "$1").trim();
  for (const candidate of [stripped, text]) {
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    const arrayMatch = candidate.match(/\[[\s\S]*\]/);
    const match = objectMatch || arrayMatch;
    if (!match) continue;
    try { return JSON.parse(match[0]) as T; } catch { /* try next */ }
  }
  return null;
}

/** Normalize a raw parsed value (array or GAQL object) into {id, name} pairs */
function normalizeGoogleCustomers(raw: unknown): Array<{ id?: string; name?: string }> {
  // Direct array (already in simplified format or GAQL format)
  if (Array.isArray(raw)) {
    return raw.map((r) => {
      const row = r as Record<string, unknown>;
      // GAQL format: {"customer.id": "...", "customer.descriptive_name": "..."}
      const gaqlId = (row["customer.id"] || row["customer_id"] || "") as string;
      const gaqlName = (row["customer.descriptive_name"] || row["customer_name"] || "") as string;
      // Simplified format: {"id": "...", "name": "..."}
      const simpleId = (row["id"] || "") as string;
      const simpleName = (row["name"] || "") as string;
      const id = gaqlId || simpleId;
      const name = gaqlName || simpleName || id;
      return { id: id.replace(/-/g, ""), name };
    });
  }
  // Object with results/customers/data array
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const arr = obj.results || obj.customers || obj.data;
    if (Array.isArray(arr)) return normalizeGoogleCustomers(arr);
  }
  return [];
}

/** Call the relay for Google Ads customers list — optional, times out gracefully */
async function fetchGoogleCustomers(timeoutMs = 45000): Promise<Array<{ id?: string; name?: string }>> {
  try {
    const text = await relayChat(
      `Call the tool mcp__mcp-google-ads__List_Customers with no parameters. ` +
      `Return ONLY a valid JSON array of objects with "id" (format "XXX-XXX-XXXX") and "name" (descriptive_name) fields. ` +
      `No explanation, no markdown, no text before or after. Example: [{"id":"123-456-7890","name":"My Account"}]`,
      timeoutMs
    );
    const parsed = extractJson<unknown>(text);
    if (parsed) {
      const normalized = normalizeGoogleCustomers(parsed);
      if (normalized.length > 0) return normalized;
    }
    console.log("[deck/clients] Google Ads response not parseable, raw:", text.slice(0, 300));
    return [];
  } catch (e) {
    console.log("[deck/clients] fetchGoogleCustomers failed:", String(e));
    return [];
  }
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
    fetchGoogleCustomers(45000),
  ]);

  console.log(`[deck/clients] Meta: ${metaAccounts.length} accounts, Google: ${googleRaw.length} customers`);
  if (googleRaw.length > 0) {
    console.log("[deck/clients] Google customers sample:", JSON.stringify(googleRaw.slice(0, 3)));
  }

  const clients: DeckClientResult[] = metaAccounts.map((acc) => ({
    id: `meta-${acc.id}`,
    name: acc.name || acc.id,
    platform: "meta" as const,
    metaAccountId: acc.id,
  }));

  // Merge Google: if same name exists in Meta, mark as "both"; otherwise add as Google-only
  for (const item of googleRaw) {
    const rawId = (item.id || "") as string;
    // Display: "Account Name (ID)" or just "ID" if no name
    const accountName = (item.name && item.name !== rawId) ? item.name : null;
    const displayName = accountName ? `${accountName} (${rawId})` : (rawId || "Google Ads Account");

    const existing = clients.find((c) =>
      c.name.toLowerCase() === (accountName || rawId).toLowerCase()
    );
    if (existing) {
      existing.platform = "both";
      existing.googleCustomerId = rawId;
      // Update display name to include ID
      existing.name = `${existing.name} (${rawId})`;
    } else {
      clients.push({
        id: `google-${rawId || Math.random()}`,
        name: displayName,
        platform: "google",
        googleCustomerId: rawId,
      });
    }
  }

  // Store result in cache
  clientCache = { data: { clients }, ts: Date.now() };

  return NextResponse.json({ clients });
}
