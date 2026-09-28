/**
 * Automatic alerting — last resort of the channel matching: the clients the
 * name rules could not place are given to the AI with the channels still
 * free, in ONE call. It proposes; an admin confirms in the page.
 */

import { relayComplete, parseLooseJson } from "@/lib/relay-chat";
import { recordAiUsage } from "@/lib/ai-usage";
import type { ChannelMatch, SlackChannel } from "@/lib/auto-alerts/slack";

export const MATCH_SYSTEM_PROMPT = `Tu rapproches des clients d'une agence média et les canaux Slack internes de l'agence (nommés c_<client>). Les noms diffèrent par des abréviations, des sigles, des marques ou des pays.

RÈGLES
- Un canal pour un client au plus, un client par canal au plus.
- Ne propose que ce dont tu es sûr : un sigle évident, une marque reconnaissable. Dans le doute, n'associe pas.
- Utilise uniquement les identifiants fournis.

RÉPONDS UNIQUEMENT par un bloc \`\`\`json : {"matches":[{"client":"<id client>","channel":"<id canal>"}]}`;

export function parseMatches(raw: string, clients: Array<{ id: string }>, channels: SlackChannel[]): ChannelMatch[] {
  const p = parseLooseJson<{ matches?: Array<{ client?: unknown; channel?: unknown }> }>(raw);
  const out: ChannelMatch[] = [];
  const usedClients = new Set<string>();
  const usedChannels = new Set<string>();
  for (const m of p?.matches ?? []) {
    const client = clients.find((c) => c.id === m.client);
    const channel = channels.find((c) => c.id === m.channel);
    if (!client || !channel || usedClients.has(client.id) || usedChannels.has(channel.id)) continue;
    usedClients.add(client.id);
    usedChannels.add(channel.id);
    out.push({ clientId: client.id, channel, confidence: "close" });
  }
  return out;
}

export async function matchWithAi(
  clients: Array<{ id: string; name: string }>,
  channels: SlackChannel[],
  user?: { id: string; email?: string | null; role: string },
): Promise<ChannelMatch[]> {
  if (!clients.length || !channels.length) return [];
  const content = [
    "CLIENTS :",
    ...clients.map((c) => `${c.id} | ${c.name}`),
    "",
    "CANAUX LIBRES :",
    ...channels.map((c) => `${c.id} | ${c.name}`),
  ].join("\n");
  const raw = await relayComplete(
    { messages: [{ role: "user", content }], systemPrompt: MATCH_SYSTEM_PROMPT, allowedServers: [], accountScope: {}, model: "sonnet", effort: "low", maxTurns: 1 },
    { maxMs: 60_000, onUsage: (u) => void recordAiUsage(u, { feature: "auto_alert", clientName: "—", user }) },
  );
  return parseMatches(raw, clients, channels);
}
