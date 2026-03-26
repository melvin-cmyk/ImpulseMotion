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
  : "https://guitar-instruments-missions-avatar.trycloudflare.com";

export interface DeckClientResult {
  id: string;
  name: string;
  platform: "meta" | "google" | "both";
  metaAccountId?: string;
  googleCustomerId?: string;
}

async function getGoogleAdsClients(): Promise<DeckClientResult[]> {
  try {
    const res = await fetch(`${RELAY_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content:
              'List all accessible Google Ads customer accounts/clients. Return ONLY a valid JSON array like: [{"id":"123-456-7890","name":"Client Name"}]. No markdown, no explanation.',
          },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) return [];

    const reader = res.body?.getReader();
    if (!reader) return [];

    const decoder = new TextDecoder();
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "delta" && event.text) fullText += event.text;
          if (event.type === "content" && event.content) fullText += event.content;
        } catch {
          // skip
        }
      }
    }

    // Extract JSON array from response
    const match = fullText.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((item: { id?: string; name?: string }) => ({
      id: `google-${item.id || Math.random()}`,
      name: item.name || item.id || "Google Ads Account",
      platform: "google" as const,
      googleCustomerId: item.id,
    }));
  } catch {
    return [];
  }
}

export async function GET() {
  const session = await auth();
  const clients: DeckClientResult[] = [];

  // Meta Ads accounts
  if (session?.metaAccessToken) {
    try {
      const accounts = await getAdAccounts(session.metaAccessToken as string);
      for (const acc of accounts) {
        clients.push({
          id: `meta-${acc.id}`,
          name: acc.name,
          platform: "meta",
          metaAccountId: acc.id,
        });
      }
    } catch {
      // Meta not available
    }
  }

  // Google Ads via relay MCP
  const googleClients = await getGoogleAdsClients();

  // Merge: if same name exists in both, mark as "both"
  for (const gc of googleClients) {
    const existing = clients.find(
      (c) => c.name.toLowerCase() === gc.name.toLowerCase()
    );
    if (existing) {
      existing.platform = "both";
      existing.googleCustomerId = gc.googleCustomerId;
    } else {
      clients.push(gc);
    }
  }

  // If no real clients found (not logged in or MCP not available),
  // return empty array so the UI can show a proper message
  return NextResponse.json({ clients });
}
