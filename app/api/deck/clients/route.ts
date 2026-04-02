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

/** Direct MCP tool call via /api/tool — bypasses AI, ~1s vs 18s via /api/chat */
async function relaySingleTool(tool: string, input: Record<string, unknown> = {}, timeoutMs = 6000): Promise<unknown> {
  let lastError: Error | null = null;
  for (const url of RELAY_URLS) {
    const isLocalhost = url.includes("localhost");
    const actualTimeout = isLocalhost ? Math.min(timeoutMs, 2000) : timeoutMs;
    try {
      const res = await fetch(`${url}/api/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool, input }),
        signal: AbortSignal.timeout(actualTimeout),
      });
      if (!res.ok) { lastError = new Error(`Relay ${url} /api/tool responded ${res.status}`); continue; }
      const json = await res.json() as { result?: unknown; error?: string };
      if (json.error) { lastError = new Error(json.error); continue; }
      return json.result;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.log(`[deck/clients] relay ${url} /api/tool error:`, String(e));
    }
  }
  throw lastError ?? new Error("All relay URLs failed for /api/tool");
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

/** Fetch Google Ads account name via GAQL for a single customer_id */
async function fetchGoogleAccountName(customerId: string, timeoutMs = 4000): Promise<string | null> {
  try {
    const gaql = JSON.stringify({
      customer_id: customerId,
      gaql_query: "SELECT customer.id, customer.descriptive_name FROM customer",
    });
    const result = await relaySingleTool("mcp-google-ads.Custom_GAQL_Query", { input: gaql }, timeoutMs);
    if (Array.isArray(result)) {
      const row = result[0]?.results?.[0]?.customer;
      return row?.descriptiveName || null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Call the relay for Google Ads customers list via direct /api/tool — fast (~2s) */
async function fetchGoogleCustomers(timeoutMs = 6000): Promise<Array<{ id?: string; name?: string }>> {
  try {
    const result = await relaySingleTool("mcp-google-ads.List_Customers", { input: "{}" }, timeoutMs);
    let ids: string[] = [];

    // Format: {"resourceNames": ["customers/XXX"]}
    if (result && typeof result === "object" && Array.isArray((result as { resourceNames?: string[] }).resourceNames)) {
      ids = ((result as { resourceNames: string[] }).resourceNames).map((rn: string) => rn.replace("customers/", ""));
    } else {
      const normalized = normalizeGoogleCustomers(result);
      if (normalized.length > 0) return normalized;
    }

    if (ids.length === 0) return [];

    // Fetch names in parallel (with per-account fallback to ID if GAQL fails)
    const perAccountTimeout = Math.max(2000, Math.floor((timeoutMs - 2000) / ids.length));
    const customers = await Promise.all(
      ids.map(async (id) => {
        const name = await fetchGoogleAccountName(id, perAccountTimeout);
        return { id, name: name || id };
      })
    );
    console.log("[deck/clients] Google customers with names:", JSON.stringify(customers));
    return customers;
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

  // Session exists but no Meta token → fetch Google Ads anyway, but flag Meta as needing reconnect
  let metaAuthExpired = !metaToken;

  // Fetch Meta + Google in parallel (skip Meta if no token)
  const [metaAccounts, googleRaw] = await Promise.all([
    metaToken
      ? getAdAccounts(metaToken).catch((e) => {
          const msg = String(e);
          console.log("[deck/clients] Meta direct API error:", msg);
          if (msg.includes("190") || msg.includes("Invalid OAuth") || msg.includes("token") || msg.includes("401") || msg.includes("OAuthException")) {
            metaAuthExpired = true;
          }
          return [] as import("@/lib/meta-api").MetaAdAccount[];
        })
      : Promise.resolve([] as import("@/lib/meta-api").MetaAdAccount[]),
    // Keep Google Ads timeout short (8s) so the route responds within Vercel's serverless limits
    fetchGoogleCustomers(8000),
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

  // If Meta expired AND no Google accounts either → full needsAuth
  if (metaAuthExpired && clients.length === 0 && googleRaw.length === 0) {
    return NextResponse.json({ clients: [], needsAuth: true, reason: metaToken ? "token_expired" : "no_meta_token" });
  }

  // Store result in cache (only when not partially degraded)
  const responseData = {
    clients,
    ...(metaAuthExpired ? { metaNeedsReconnect: true } : {}),
  };
  if (!metaAuthExpired) {
    clientCache = { data: { clients }, ts: Date.now() };
  }

  return NextResponse.json(responseData);
}
