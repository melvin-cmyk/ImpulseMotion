/**
 * GET /api/deck/clients
 * Returns real clients from Meta Ads (ad accounts) + Google Ads (customers)
 * via the relay proxy MCP tools.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getAdAccounts } from "@/lib/meta-api";

const rawRelayUrl = (process.env.NEXT_PUBLIC_RELAY_URL || "").trim();
const RELAY_URL = rawRelayUrl
  ? rawRelayUrl.startsWith("http") ? rawRelayUrl : `https://${rawRelayUrl}`
  : "http://localhost:3457";

// Server-side: try localhost first (always available), then configured URL as fallback
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

async function relayChat(prompt: string, timeoutMs = 25000): Promise<string> {
  console.log("[deck/clients] RELAY_URLS:", RELAY_URLS, "timeout:", timeoutMs);
  for (const url of RELAY_URLS) {
    try {
      console.log("[deck/clients] trying relay:", url);
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;

      const reader = res.body?.getReader();
      if (!reader) continue;

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
            // "content" is the final complete text from the relay — replace, don't append (avoids duplicate JSON)
            if (event.type === "content" && typeof event.text === "string") { fullText = event.text; continue; }
            if (event.type === "content" && typeof event.content === "string") { fullText = event.content; continue; }
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") { fullText += event.delta.text; continue; }
            if (event.choices?.[0]?.delta?.content) { fullText += event.choices[0].delta.content; continue; }
          } catch { /* skip */ }
        }
      }

      console.log("[deck/clients] fullText length:", fullText.length, "preview:", fullText.slice(0, 200));
      if (fullText.trim()) return fullText;
    } catch (e) { console.log("[deck/clients] relay error:", String(e)); }
  }
  return "";
}

function extractJsonArray(text: string): Array<{ id?: string; name?: string }> | null {
  const stripped = text.replace(/```(?:json)?\n?([\s\S]*?)\n?```/g, "$1").trim();
  for (const candidate of [stripped, text]) {
    const match = candidate.match(/\[[\s\S]*\]/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* try next */ }
  }
  return null;
}

interface AllAccountsResult {
  meta: Array<{ id?: string; name?: string }>;
  google: Array<{ id?: string; name?: string }>;
}

async function getAllClients(): Promise<AllAccountsResult> {
  try {
    const text = await relayChat(
      `Call BOTH of these MCP tools:
1. mcp__meta-ads-impulse__List_Ad_Accounts1 with fields="id,name" and limit="100"
2. mcp__mcp-google-ads__List_Customers (no params needed)

Then return ONLY this exact JSON structure with the real data (no markdown, no explanation):
{"meta":[{"id":"act_xxx","name":"Client Name"}],"google":[{"id":"123-456-7890","name":"Client Name"}]}`,
      30000
    );
    const result = (() => {
      const stripped = text.replace(/```(?:json)?\n?([\s\S]*?)\n?```/g, "$1").trim();
      for (const candidate of [stripped, text]) {
        const match = candidate.match(/\{[\s\S]*\}/);
        if (!match) continue;
        try {
          const parsed = JSON.parse(match[0]) as AllAccountsResult;
          if (parsed.meta || parsed.google) return parsed;
        } catch { /* next */ }
      }
      return null;
    })();
    return { meta: result?.meta ?? [], google: result?.google ?? [] };
  } catch {
    return { meta: [], google: [] };
  }
}

export async function GET() {
  const { meta: metaRaw, google: googleRaw } = await getAllClients();

  const clients: DeckClientResult[] = metaRaw.map((item) => ({
    id: `meta-${item.id || Math.random()}`,
    name: item.name || item.id || "Meta Ads Account",
    platform: "meta" as const,
    metaAccountId: item.id,
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

  return NextResponse.json({ clients });
}
