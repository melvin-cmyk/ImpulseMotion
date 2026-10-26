/**
 * The AI thread of a design (DesignFile.messagesJson): parse, cap, append.
 * One thread per design, shared by the staff; a message records its author.
 */

import { prisma } from "@/lib/prisma";
import type { DesignMessage } from "@/lib/design/model";

const MAX_STORED_MESSAGES = 200;
const MAX_CONTENT_CHARS = 60_000;

export function parseDesignMessages(json: string | null | undefined): DesignMessage[] {
  if (!json) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: DesignMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    if ((r.role !== "user" && r.role !== "assistant") || typeof r.content !== "string") continue;
    out.push({
      role: r.role,
      content: r.content.slice(0, MAX_CONTENT_CHARS),
      at: typeof r.at === "string" ? r.at : new Date(0).toISOString(),
      ...(typeof r.author === "string" ? { author: r.author } : {}),
      ...(Array.isArray(r.images) ? { images: r.images as DesignMessage["images"] } : {}),
      ...(Array.isArray(r.files) ? { files: r.files as DesignMessage["files"] } : {}),
    });
  }
  return out;
}

export function serializeDesignMessages(messages: DesignMessage[]): string {
  return JSON.stringify(messages.slice(-MAX_STORED_MESSAGES));
}

/** Appends messages to the design's thread (images are kept out of storage: they weigh too much). */
export async function appendDesignMessages(designId: string, messages: DesignMessage[]): Promise<void> {
  const row = await prisma.designFile.findUnique({ where: { id: designId }, select: { messagesJson: true } });
  if (!row) return;
  const stored = messages.map((m) => { const { images, ...rest } = m; void images; return rest; });
  const all = [...parseDesignMessages(row.messagesJson), ...stored];
  await prisma.designFile.update({ where: { id: designId }, data: { messagesJson: serializeDesignMessages(all) } });
}
