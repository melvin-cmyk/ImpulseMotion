/**
 * GET /api/deck/clients
 * Returns real clients from Meta Ads (direct Graph API) + Google Ads (via relay MCP).
 * Meta accounts are fetched directly from the Graph API using the session token — fast (~1s).
 * Google Ads accounts use the relay MCP — slower, fetched in parallel and optional.
 */

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { getAllowedAccountIds } from "@/lib/acl";
import { getAdAccounts, getMetaSystemToken } from "@/lib/meta-api";
import { relayHeaders } from "@/lib/relay-headers";

import { RELAY_URLS } from "@/lib/relay-server";

export interface DeckClientResult {
  id: string;
  name: string;
  platform: "meta" | "google" | "both";
  metaAccountId?: string;
  googleCustomerId?: string;
  gaPropertyId?: string;
}

let clientCache: { data: { clients: DeckClientResult[] }; ts: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/** Direct MCP tool call via /api/tool — bypasses AI, ~1s vs 18s via /api/chat */
async function relaySingleTool(tool: string, input: Record<string, unknown> = {}, timeoutMs = 6000): Promise<unknown> {
  let lastError: Error | null = null;
  for (const url of RELAY_URLS) {
    const isLocalhost = url.includes("localhost");
    const actualTimeout = isLocalhost ? Math.min(timeoutMs, 2000) : timeoutMs;
    try {
      const res = await fetch(`${url}/api/tool`, {
        method: "POST",
        headers: relayHeaders(),
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

/** Fetch all client sub-accounts from the MCC via customer_client GAQL */
async function fetchSubAccountsFromMCC(mccId: string, timeoutMs = 6000): Promise<Array<{ id: string; name: string }>> {
  try {
    const gaql = JSON.stringify({
      customer_id: mccId,
      gaql_query:
        "SELECT customer_client.id, customer_client.descriptive_name, customer_client.level FROM customer_client WHERE customer_client.level = 1",
    });
    const result = await relaySingleTool("mcp-google-ads.Custom_GAQL_Query", { input: gaql }, timeoutMs);
    if (!Array.isArray(result) || result.length === 0) return [];
    const rows = (result[0] as { results?: Array<{ customerClient?: { id?: string; descriptiveName?: string } }> })?.results || [];
    return rows
      .map((r) => {
        const cc = r.customerClient;
        const id = String(cc?.id || "").replace(/-/g, "");
        const name = cc?.descriptiveName || id;
        return { id, name };
      })
      .filter((c) => c.id);
  } catch (e) {
    console.log(`[deck/clients] fetchSubAccountsFromMCC(${mccId}) failed:`, String(e));
    return [];
  }
}

/** Fetch Google Ads accounts: tries sub-accounts from MCC first, then falls back to direct account names */
async function fetchGoogleCustomers(timeoutMs = 8000): Promise<Array<{ id?: string; name?: string }>> {
  try {
    const listResult = await relaySingleTool("mcp-google-ads.List_Customers", { input: "{}" }, Math.min(timeoutMs, 4000));
    let rootIds: string[] = [];

    // Format: {"resourceNames": ["customers/XXX"]}
    if (listResult && typeof listResult === "object" && Array.isArray((listResult as { resourceNames?: string[] }).resourceNames)) {
      rootIds = ((listResult as { resourceNames: string[] }).resourceNames).map((rn: string) => rn.replace("customers/", ""));
    } else {
      const normalized = normalizeGoogleCustomers(listResult);
      if (normalized.length > 0) return normalized;
    }

    if (rootIds.length === 0) return [];

    // Try to get sub-accounts from each root ID (in case it's a MCC)
    const perMccTimeout = Math.max(3000, Math.floor((timeoutMs - 4000) / rootIds.length));
    const subAccountArrays = await Promise.all(
      rootIds.map((id) => fetchSubAccountsFromMCC(id, perMccTimeout))
    );

    // Flatten and deduplicate
    const allSubAccounts = subAccountArrays.flat();
    const seen = new Set<string>();
    const unique = allSubAccounts.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });

    if (unique.length > 0) {
      console.log(`[deck/clients] Found ${unique.length} Google sub-accounts via MCC`);
      return unique;
    }

    // Fallback: return root IDs with their names via simple GAQL
    const customers = await Promise.all(
      rootIds.map(async (id) => {
        try {
          const gaql = JSON.stringify({ customer_id: id, gaql_query: "SELECT customer.id, customer.descriptive_name FROM customer" });
          const res = await relaySingleTool("mcp-google-ads.Custom_GAQL_Query", { input: gaql }, 3000);
          if (Array.isArray(res) && res.length > 0) {
            const name = (res[0] as { results?: Array<{ customer?: { descriptiveName?: string } }> })?.results?.[0]?.customer?.descriptiveName;
            return { id, name: name || id };
          }
        } catch { /* ignore */ }
        return { id, name: id };
      })
    );
    return customers;
  } catch (e) {
    console.log("[deck/clients] fetchGoogleCustomers failed:", String(e));
    return [];
  }
}

/** Fetch GA4 properties via MCP — first list accounts, then list properties for each */
async function fetchGAProperties(timeoutMs = 6000): Promise<Array<{ id: string; name: string; linkedGoogleAdsIds: string[] }>> {
  try {
    // Step 1: List GA4 accounts
    const accountsResult = await relaySingleTool("mcp-google-analytics.list_accounts", {}, Math.min(timeoutMs, 3000));
    let accounts: Array<Record<string, unknown>> = [];
    if (Array.isArray(accountsResult)) {
      accounts = accountsResult;
    } else if (accountsResult && typeof accountsResult === "object") {
      const obj = accountsResult as Record<string, unknown>;
      if (Array.isArray(obj.accounts)) accounts = obj.accounts as typeof accounts;
    }

    if (accounts.length === 0) {
      // Try listing properties directly (some MCP implementations don't need account_id)
      const directResult = await relaySingleTool("mcp-google-analytics.list_properties", {}, timeoutMs);
      return parseGAProperties(directResult);
    }

    // Step 2: List properties for each account in parallel
    const allProperties: Array<{ id: string; name: string; linkedGoogleAdsIds: string[] }> = [];
    const perAccountTimeout = Math.max(2000, Math.floor((timeoutMs - 3000) / accounts.length));

    await Promise.all(accounts.map(async (acc) => {
      const accountId = String(acc.name || acc.account_id || acc.id || "").replace("accounts/", "");
      if (!accountId) return;
      try {
        const propsResult = await relaySingleTool("mcp-google-analytics.list_properties", { account_id: accountId }, perAccountTimeout);
        const props = parseGAProperties(propsResult);
        allProperties.push(...props);
      } catch (e) {
        console.log(`[deck/clients] list_properties(${accountId}) failed:`, String(e));
      }
    }));

    // Step 3: For each property, fetch linked Google Ads accounts (for smart matching)
    await Promise.all(allProperties.map(async (prop) => {
      try {
        const linksResult = await relaySingleTool("mcp-google-analytics.list_google_ads_links", { property_id: prop.id }, 3000);
        let links: Array<Record<string, unknown>> = [];
        if (Array.isArray(linksResult)) {
          links = linksResult;
        } else if (linksResult && typeof linksResult === "object") {
          const obj = linksResult as Record<string, unknown>;
          if (Array.isArray(obj.googleAdsLinks)) links = obj.googleAdsLinks as typeof links;
        }
        for (const link of links) {
          const customerId = String(link.customerId || link.customer_id || "").replace(/-/g, "");
          if (customerId) prop.linkedGoogleAdsIds.push(customerId);
        }
      } catch {
        // Not critical — fall back to name matching
      }
    }));

    return allProperties;
  } catch (e) {
    console.log("[deck/clients] fetchGAProperties failed:", String(e));
    return [];
  }
}

function parseGAProperties(raw: unknown): Array<{ id: string; name: string; linkedGoogleAdsIds: string[] }> {
  if (!raw) return [];
  let properties: Array<Record<string, unknown>> = [];
  if (Array.isArray(raw)) {
    properties = raw;
  } else if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.properties)) properties = obj.properties as typeof properties;
  }

  return properties.map((p) => {
    const rawId = String(p.name || p.property_id || p.id || "");
    const id = rawId.replace("properties/", "");
    const displayName = String(p.displayName || p.display_name || id);
    return { id, name: displayName, linkedGoogleAdsIds: [] };
  }).filter((p) => p.id);
}

export async function GET() {
  const guard = await requireSession();
  if ("error" in guard) return guard.error;

  const isAdmin = guard.session.role === "admin";
  const [allowedMetaIds, allowedGoogleIds] = await Promise.all([
    isAdmin ? Promise.resolve<string[] | null>(null) : getAllowedAccountIds(guard.session.userId, "meta"),
    isAdmin ? Promise.resolve<string[] | null>(null) : getAllowedAccountIds(guard.session.userId, "google"),
  ]);

  if (!isAdmin && allowedMetaIds!.length === 0 && allowedGoogleIds!.length === 0) {
    return NextResponse.json({ clients: [] });
  }

  const metaAllowedSet = allowedMetaIds
    ? new Set(allowedMetaIds.flatMap((id) => {
        const n = id.replace(/^act_/, "");
        return [n, `act_${n}`];
      }))
    : null;
  const googleAllowedSet = allowedGoogleIds
    ? new Set(allowedGoogleIds.map((id) => id.replace(/-/g, "")))
    : null;

  const metaToken = (() => {
    try { return getMetaSystemToken(); } catch { return null; }
  })();

  if (!metaToken) {
    return NextResponse.json({ clients: [], needsAuth: true, reason: "no_meta_token" });
  }

  // Check if Meta token is available (either from session or shared env)
  let metaAuthExpired = !metaToken;

  // Fetch Meta + Google + GA in parallel
  const [metaAccountsAll, googleRawAll, gaProperties] = await Promise.all([
    getAdAccounts(metaToken).catch((e) => {
      const msg = String(e);
      console.log("[deck/clients] Meta direct API error:", msg);
      if (msg.includes("190") || msg.includes("Invalid OAuth") || msg.includes("token") || msg.includes("401") || msg.includes("OAuthException")) {
        metaAuthExpired = true;
      }
      return [] as import("@/lib/meta-api").MetaAdAccount[];
    }),
    fetchGoogleCustomers(8000),
    fetchGAProperties(6000),
  ]);

  const metaAccounts = metaAllowedSet
    ? metaAccountsAll.filter((a) => metaAllowedSet.has(a.id))
    : metaAccountsAll;
  const googleRaw = googleAllowedSet
    ? googleRawAll.filter((g) => {
        const clean = String(g.id ?? "").replace(/-/g, "");
        return clean && googleAllowedSet.has(clean);
      })
    : googleRawAll;

  console.log(`[deck/clients] Meta: ${metaAccounts.length} accounts, Google: ${googleRaw.length} customers, GA: ${gaProperties.length} properties`);
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

  // Merge GA properties: match via Google Ads link, then by name, then fallback
  if (gaProperties.length > 0) {
    const usedGaIds = new Set<string>();

    // Pass 1: Match via Google Ads links (most reliable)
    for (const client of clients) {
      if (client.gaPropertyId) continue;
      if (!client.googleCustomerId) continue;
      const cleanGadsId = client.googleCustomerId.replace(/-/g, "");
      const match = gaProperties.find((p) =>
        !usedGaIds.has(p.id) && p.linkedGoogleAdsIds.includes(cleanGadsId)
      );
      if (match) {
        client.gaPropertyId = match.id;
        usedGaIds.add(match.id);
        console.log(`[deck/clients] GA matched via Ads link: ${client.name} → GA ${match.name} (${match.id})`);
      }
    }

    // Pass 2: Match by name similarity (fuzzy)
    for (const client of clients) {
      if (client.gaPropertyId) continue;
      // Extract base name (remove IDs in parentheses, trim)
      const clientBase = client.name.replace(/\s*\(.*\)\s*/g, "").trim().toLowerCase();
      if (!clientBase || clientBase.length < 2) continue;

      const match = gaProperties.find((p) => {
        if (usedGaIds.has(p.id)) return false;
        const gaBase = p.name.toLowerCase();
        // Check if either contains the other, or if first significant word matches
        return gaBase.includes(clientBase) ||
          clientBase.includes(gaBase) ||
          (clientBase.split(/\s+/)[0].length >= 3 && gaBase.includes(clientBase.split(/\s+/)[0])) ||
          (gaBase.split(/\s+/)[0].length >= 3 && clientBase.includes(gaBase.split(/\s+/)[0]));
      });
      if (match) {
        client.gaPropertyId = match.id;
        usedGaIds.add(match.id);
        console.log(`[deck/clients] GA matched via name: ${client.name} → GA ${match.name} (${match.id})`);
      }
    }

    // Pass 3: If only one GA property and still unmatched clients, assign to all
    if (gaProperties.length === 1 && !clients.some((c) => c.gaPropertyId)) {
      const gaProp = gaProperties[0];
      for (const client of clients) {
        client.gaPropertyId = gaProp.id;
      }
      console.log(`[deck/clients] GA single property fallback: assigned ${gaProp.name} (${gaProp.id}) to all ${clients.length} clients`);
    }

    console.log(`[deck/clients] GA matching: ${clients.filter(c => c.gaPropertyId).length}/${clients.length} clients linked`);
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
