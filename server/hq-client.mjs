/**
 * Direct MCP client for HQ (hq-mcp.hq.computer), authenticated with the
 * relay's own bearer (server/hq-oauth.mjs). Used for the few WRITES the app
 * makes to HQ on the consultant's behalf (journal d'un projet client) — a
 * deterministic call from code, never something the model does on its own:
 * the CLI only ever sees HQ_READ_TOOLS.
 *
 * Streamable HTTP transport, one short session per call: initialize →
 * notifications/initialized → tools/call. Answers may come as JSON or SSE.
 */
import * as hqOauth from "./hq-oauth.mjs";

const HQ_MCP_URL = process.env.HQ_MCP_URL || "https://hq-mcp.hq.computer/mcp";
const PROTOCOL = "2025-03-26";

async function post(body, token, sessionId) {
  const res = await fetch(HQ_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const sid = res.headers.get("mcp-session-id") || sessionId || null;
  if (res.status === 202 || res.status === 204) return { sid, json: null };
  if (!res.ok) throw new Error(`HQ ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("text/event-stream")) {
    const text = await res.text();
    // Last JSON-RPC message with our id wins (progress notifications may precede it).
    let last = null;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg && msg.id === body.id) last = msg;
      } catch { /* keepalive */ }
    }
    return { sid, json: last };
  }
  return { sid, json: await res.json() };
}

/** Calls one HQ tool and returns its text content (joined), or throws. */
export async function hqToolCall(name, args) {
  const token = await hqOauth.getAccessToken();
  if (!token) throw new Error("aucun jeton HQ valide (server/hq-oauth.mjs)");
  const init = await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "impulsemotion-relay", version: "1.0.0" } },
  }, token, null);
  if (init.json?.error) throw new Error(`HQ initialize: ${init.json.error.message}`);
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, token, init.sid).catch(() => {});
  const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, token, init.sid);
  if (!call.json) throw new Error("HQ: réponse vide");
  if (call.json.error) throw new Error(`HQ ${name}: ${call.json.error.message}`);
  const result = call.json.result ?? {};
  const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (result.isError) throw new Error(`HQ ${name}: ${text.slice(0, 300) || "erreur"}`);
  return text;
}
