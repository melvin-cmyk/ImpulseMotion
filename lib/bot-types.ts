/**
 * Shared types for the private client bot (ClientBot / BotConversation).
 *
 * `sourcesJson` and `messagesJson` are stored as text on the Prisma models;
 * these helpers are the single place that parses / serialises them so every
 * consumer (admin UI, chat route, prompt builder) agrees on the shape.
 */

export interface BotSources {
  /** Meta Ads (dashboard.metaAccountId) → MCP server "meta-ads-impulse" */
  meta?: boolean;
  /** Google Ads (dashboard.googleCustomerId) → MCP server "mcp-google-ads" */
  google?: boolean;
  /** GA4 property id (digits) → MCP server "mcp-google-analytics" */
  ga4PropertyId?: string;
  /** E-commerce warehouse (client_data schema) → MCP server "client-data" */
  data?: boolean;
}

export interface BotMessage {
  role: "user" | "assistant";
  content: string;
  /** ISO timestamp */
  at: string;
}

/** Parses `ClientBot.sourcesJson`; never throws (unknown / broken JSON → {}). */
export function parseSources(json: string | null | undefined): BotSources {
  if (!json) return {};
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: BotSources = {};
  if (o.meta === true) out.meta = true;
  if (o.google === true) out.google = true;
  if (o.data === true) out.data = true;
  if (typeof o.ga4PropertyId === "string") {
    const id = o.ga4PropertyId.trim().replace(/^properties\//, "");
    if (id) out.ga4PropertyId = id;
  }
  return out;
}

/** Serialises sources for `ClientBot.sourcesJson` (drops falsy / empty keys). */
export function serializeSources(sources: BotSources | null | undefined): string {
  const out: BotSources = {};
  if (sources?.meta) out.meta = true;
  if (sources?.google) out.google = true;
  if (sources?.data) out.data = true;
  const ga4 = sources?.ga4PropertyId?.trim().replace(/^properties\//, "");
  if (ga4) out.ga4PropertyId = ga4;
  return JSON.stringify(out);
}

/** Parses `BotConversation.messagesJson`; drops malformed entries, never throws. */
export function parseMessages(json: string | null | undefined): BotMessage[] {
  if (!json) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: BotMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const { role, content, at } = m as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    out.push({ role, content, at: typeof at === "string" ? at : new Date(0).toISOString() });
  }
  return out;
}

export function serializeMessages(messages: BotMessage[]): string {
  return JSON.stringify(messages);
}

/** Maps enabled sources to the relay MCP server names (order is stable). */
export function serversForSources(sources: BotSources): string[] {
  const servers: string[] = [];
  if (sources.meta) servers.push("meta-ads-impulse");
  if (sources.google) servers.push("mcp-google-ads");
  if (sources.ga4PropertyId) servers.push("mcp-google-analytics");
  if (sources.data) servers.push("client-data");
  return servers;
}

/** Shape returned by GET /api/bot for the client UI. */
export interface BotSummary {
  id: string;
  name: string;
  dashboardName: string;
  sources: BotSources;
}
