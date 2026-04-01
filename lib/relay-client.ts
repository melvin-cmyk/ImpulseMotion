/**
 * Relay server client for ImpulseMotion AI chat.
 *
 * Strategy:
 * 1. Try http://localhost:3457 directly from the browser (CORS: * on the relay).
 *    This always works when the browser and relay are on the same machine.
 * 2. Try the public relay IP directly from the browser (CORS: * is enabled).
 * 3. Fall back to the server-side proxy /api/relay/chat.
 *
 * Detection is cached so it only happens once per page load.
 */

const RELAY_DIRECT = "http://localhost:3457";
const RELAY_PUBLIC_IP = "http://72.62.29.196:3457";
const RELAY_PROXY_CHAT = "/api/relay/chat";
const RELAY_PROXY_TOOLS = "/api/relay/tools";

// null = unknown, "" = use proxy, "http://..." = use direct
let _relayBase: string | null = null;

/** Detect if the relay is reachable directly from the browser. Cached. */
export async function detectRelayBase(): Promise<string> {
  if (_relayBase !== null) return _relayBase;

  // Try localhost first (fast path when browser and relay are co-located)
  try {
    const res = await fetch(`${RELAY_DIRECT}/api/tools`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.status < 500) {
      _relayBase = RELAY_DIRECT;
      return _relayBase;
    }
  } catch { /* connection refused or timeout */ }

  // Try public IP directly (CORS: * enabled on relay)
  try {
    const res = await fetch(`${RELAY_PUBLIC_IP}/api/tools`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.status < 500) {
      _relayBase = RELAY_PUBLIC_IP;
      return _relayBase;
    }
  } catch { /* unreachable */ }

  _relayBase = ""; // use server proxy
  return _relayBase;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StreamEvent {
  type: "init" | "delta" | "content" | "tool_call" | "tool_result" | "usage" | "error" | "done";
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  content?: string;
  is_error?: boolean;
  tools?: string[];
  servers?: { name: string; status: string }[];
  cost?: number;
  turns?: number;
  duration?: number;
  message?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delta?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  choices?: any[];
}

async function readStream(
  res: Response,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      try {
        const event: StreamEvent = JSON.parse(trimmed.slice(6));
        onEvent(event);
      } catch {
        // skip invalid JSON
      }
    }
  }
}

export async function streamChat(
  messages: ChatMessage[],
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const base = await detectRelayBase();
  const url = base ? `${base}/api/chat` : RELAY_PROXY_CHAT;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Relay error: ${res.status}`);
  }

  await readStream(res, onEvent);
}

export async function getTools(): Promise<{ server: string; name: string; description: string }[]> {
  const base = await detectRelayBase();
  const url = base ? `${base}/api/tools` : RELAY_PROXY_TOOLS;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to get tools: ${res.status}`);
  const data = await res.json();
  return data.tools;
}
