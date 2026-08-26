import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { relayHeaders } from "@/lib/relay-headers";

import { RELAY_URLS } from "@/lib/relay-server";

type ToolResult<T> = { result: T } | { error: string };

async function callRelayTool<T>(tool: string, inputJson: string): Promise<T> {
  let lastErr: unknown = null;
  for (const url of RELAY_URLS) {
    const isLocal = url.includes("localhost");
    try {
      const res = await fetch(`${url}/api/tool`, {
        method: "POST",
        headers: relayHeaders(),
        body: JSON.stringify({ tool, input: { input: inputJson } }),
        signal: AbortSignal.timeout(isLocal ? 8000 : 20000),
      });
      const data = (await res.json()) as ToolResult<T>;
      if (!res.ok || "error" in data) {
        lastErr = "error" in data ? data.error : `HTTP ${res.status}`;
        continue;
      }
      return data.result;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(typeof lastErr === "string" ? lastErr : "Relay unreachable");
}

type ListCustomersResult = { resourceNames: string[] };
type GaqlResult = Array<{
  results?: Array<{
    customerClient?: {
      id: string;
      descriptiveName?: string;
      currencyCode?: string;
      manager?: boolean;
    };
    customer?: {
      id: string;
      descriptiveName?: string;
      currencyCode?: string;
    };
  }>;
}>;

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;

  try {
    const list = await callRelayTool<ListCustomersResult>(
      "mcp-google-ads.List_Customers",
      "{}"
    );
    const topLevelIds = (list.resourceNames || [])
      .map((r) => r.replace(/^customers\//, ""))
      .filter(Boolean);

    const accounts = new Map<
      string,
      { accountId: string; name: string; currency: string }
    >();

    for (const id of topLevelIds) {
      // Try MCC → list clients
      try {
        const mccClients = await callRelayTool<GaqlResult>(
          "mcp-google-ads.Custom_GAQL_Query",
          JSON.stringify({
            customer_id: id,
            gaql_query:
              "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager FROM customer_client",
          })
        );
        const rows = mccClients[0]?.results ?? [];
        if (rows.length > 0) {
          for (const row of rows) {
            const c = row.customerClient;
            if (!c || c.manager) continue;
            accounts.set(c.id, {
              accountId: c.id,
              name: c.descriptiveName || c.id,
              currency: c.currencyCode || "",
            });
          }
          continue;
        }
      } catch {
        // not an MCC or no permission — fall through
      }

      // Leaf account: fetch its own info
      try {
        const self = await callRelayTool<GaqlResult>(
          "mcp-google-ads.Custom_GAQL_Query",
          JSON.stringify({
            customer_id: id,
            gaql_query:
              "SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1",
          })
        );
        const row = self[0]?.results?.[0]?.customer;
        if (row) {
          accounts.set(row.id, {
            accountId: row.id,
            name: row.descriptiveName || row.id,
            currency: row.currencyCode || "",
          });
        }
      } catch {
        // skip
      }
    }

    const out = Array.from(accounts.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    return NextResponse.json({ accounts: out });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Relay error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
