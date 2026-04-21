export function relayHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  };
  const secret = process.env.RELAY_SHARED_SECRET;
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}
