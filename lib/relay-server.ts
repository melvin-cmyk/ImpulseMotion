/**
 * Single source of truth for resolving the relay base URL server-side.
 *
 * Order: localhost (co-located dev), then RELAY_URL / NEXT_PUBLIC_RELAY_URL.
 * The relay is only reachable server-to-server with the shared secret
 * (see lib/relay-headers.ts) — never from the browser.
 */

const rawRelayUrl = (process.env.RELAY_URL || process.env.NEXT_PUBLIC_RELAY_URL || "").trim();
const CONFIGURED_URL = rawRelayUrl
  ? rawRelayUrl.startsWith("http") ? rawRelayUrl : `https://${rawRelayUrl}`
  : null;

export const RELAY_URLS: string[] = [
  "http://localhost:3457",
  ...(CONFIGURED_URL && CONFIGURED_URL !== "http://localhost:3457" ? [CONFIGURED_URL] : []),
];
