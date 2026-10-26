/**
 * Design files (FigCraft): the shapes the pages, the API and the AI thread share.
 *
 * A design is a FigCraft file on the agency's collaboration server (created by
 * the relay, server/figcraft.mjs). Consultants edit it in the browser (the
 * FigCraft web build in an iframe, joined with the file's edit link) and the
 * AI edits it with them, live, from a detached job that joins the same file
 * (server/mcp-figcraft.mjs). The thread of that AI is shared by the staff.
 */

import type { ChatFile, ChatImage } from "@/lib/ai-chat-shared";

export const DESIGN_NAME_MAX = 120;

/** Artboards offered when a design is created (width × height in px). "free" = an empty page. */
export const DESIGN_PRESETS = [
  { key: "square", label: "Carré 1080 × 1080 (Meta, Instagram)", width: 1080, height: 1080 },
  { key: "portrait", label: "Portrait 1080 × 1350 (feed Instagram)", width: 1080, height: 1350 },
  { key: "story", label: "Story / Reel 1080 × 1920", width: 1080, height: 1920 },
  { key: "landscape", label: "Paysage 1200 × 628 (lien Meta, display)", width: 1200, height: 628 },
  { key: "hd", label: "Écran 1920 × 1080 (YouTube, slide)", width: 1920, height: 1080 },
  { key: "banner", label: "Bannière 728 × 90 (display)", width: 728, height: 90 },
  { key: "free", label: "Page vide (sans cadre)", width: 0, height: 0 },
] as const;
export type DesignPresetKey = (typeof DESIGN_PRESETS)[number]["key"];

export function presetByKey(key: unknown): (typeof DESIGN_PRESETS)[number] | null {
  return DESIGN_PRESETS.find((p) => p.key === key) ?? null;
}

export const EXPORT_FORMATS = ["png", "jpg", "webp", "svg", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface DesignMessage {
  role: "user" | "assistant";
  content: string;
  /** ISO date */
  at: string;
  /** Who asked (the thread is shared by the staff). */
  author?: string | null;
  images?: ChatImage[];
  files?: ChatFile[];
}

export interface DesignListItem {
  id: string;
  name: string;
  clientDashboardId: string | null;
  clientName: string | null;
  ownerId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
  /** Rename / delete: the owner or an admin. */
  canManage: boolean;
}

export interface DesignDetail extends DesignListItem {
  /** The FigCraft editor, joined on the file with edit access (iframe src). */
  editorUrl: string | null;
  messages: DesignMessage[];
  /** A reply being produced on this design (any staff member), else null. */
  jobId: string | null;
}

/** One CLI session (and one workspace) per design: the thread is shared. */
export function designSessionKey(designId: string): string {
  return `design:${designId}`;
}

/**
 * The editor URL for a share link: the link goes in the fragment (never sent
 * to the host serving the editor), as FigCraft's web build expects.
 */
export function editorUrlFor(base: string | null | undefined, link: string): string | null {
  const b = (base || "").trim().replace(/\/+$/, "");
  if (!b || !link) return null;
  return `${b}/#join=${encodeURIComponent(link)}`;
}

export const DESIGN_FILES_UPLOAD_RE = /\.(png|jpe?g|webp|gif|svg|figcraft|fig|json|pdf)$/i;
export const DESIGN_FILES_ACCEPT = "image/*,.svg,.figcraft,.fig,.json,.pdf";
