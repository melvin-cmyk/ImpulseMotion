/**
 * Server-side calls to the relay's FigCraft routes (server/figcraft.mjs):
 * create a design file, export it, delete it. The relay alone holds the
 * collaboration server's key; the app keeps a file's share links.
 */

import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import type { ExportFormat } from "@/lib/design/model";

async function relay<T>(path: string, init: { method: "GET" | "POST" | "DELETE"; body?: unknown }, timeoutMs: number): Promise<T> {
  let lastError = "relay indisponible";
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}${path}`, {
        method: init.method,
        headers: relayHeaders(),
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(url.includes("localhost") && RELAY_URLS.length > 1 ? Math.min(timeoutMs, 3000) : timeoutMs),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string } & T;
      if (!res.ok) {
        // A refusal is final: the next URL would answer the same.
        if (res.status >= 400 && res.status < 500) throw new Error(json.error ?? `relay ${res.status}`);
        lastError = json.error ?? `relay ${res.status}`;
        continue;
      }
      return json;
    } catch (e) {
      if (e instanceof Error && !/abort|fetch failed|ECONNREFUSED|timeout/i.test(e.message)) throw e;
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastError);
}

export interface CreatedDesignFile { fileId: string; name: string; editLink: string; viewLink: string }

export function createDesignFile(input: { name: string; width?: number; height?: number; frameName?: string }): Promise<CreatedDesignFile> {
  return relay<CreatedDesignFile>("/api/figcraft/files", { method: "POST", body: input }, 60_000);
}

export function deleteDesignFile(fileId: string): Promise<{ removed: boolean; missing: boolean }> {
  return relay("/api/figcraft/files/" + encodeURIComponent(fileId), { method: "DELETE" }, 30_000);
}

export async function exportDesignFile(input: { link: string; format: ExportFormat; scale?: number }): Promise<{ bytes: Buffer; mimeType: string; format: string }> {
  const out = await relay<{ data: string; mimeType: string; format: string }>("/api/figcraft/export", { method: "POST", body: input }, 180_000);
  return { bytes: Buffer.from(out.data, "base64"), mimeType: out.mimeType, format: out.format };
}

export async function designRelayStatus(): Promise<{ configured: boolean; server: { ok: boolean } | null }> {
  try {
    return await relay<{ configured: boolean; server: { ok: boolean } | null }>("/api/figcraft/status", { method: "GET" }, 8_000);
  } catch {
    return { configured: false, server: null };
  }
}
