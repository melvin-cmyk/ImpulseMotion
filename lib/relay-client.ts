/**
 * Relay server client for ImpulseMotion AI chat.
 *
 * All browser traffic goes through the authenticated server-side proxy
 * (/api/relay/*). The proxy enforces the session, the per-user MCP server
 * allowlist and the account scope before anything reaches the relay — the
 * browser must never talk to the relay directly.
 */

const RELAY_PROXY_CHAT = "/api/relay/chat";
const RELAY_PROXY_TOOLS = "/api/relay/tools";

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
  const res = await fetch(RELAY_PROXY_CHAT, {
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
  const res = await fetch(RELAY_PROXY_TOOLS);
  if (!res.ok) throw new Error(`Failed to get tools: ${res.status}`);
  const data = await res.json();
  return data.tools;
}
