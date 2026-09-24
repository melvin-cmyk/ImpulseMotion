/**
 * Workspace du bac à sable (server/mcp-sandbox.mjs) : un dossier par
 * conversation côté relay, identifié par un hash de la sessionKey. L'app doit
 * calculer le même identifiant que le relay pour servir les fichiers produits
 * (graphiques, exports) et déposer ceux du consultant.
 */

import { createHash } from "node:crypto";

export function workspaceIdFor(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 24);
}

/** Chemins de fichiers acceptés dans un workspace (sous out/ ou uploads/, sans traversée). */
export const WORKSPACE_PATH_RE = /^(out|uploads)\/[A-Za-z0-9._ \-()]{1,120}$/;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
  csv: "text/csv; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel",
  pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", html: "text/plain; charset=utf-8",
};

export function contentTypeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
