/**
 * The Google Drive folder of a client (Dashboard.driveFolderId): one folder
 * per client under the agency's « ImpulseMotion – Clients » folder in the
 * data@ Drive, created by the relay (server/drive-direct.mjs) the first time
 * it is needed — a client "has" a folder as soon as it has a Meta or Google
 * account. Designs and exports land in Designs/<design name>/ inside it.
 */

import { prisma } from "@/lib/prisma";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";

export interface DriveFolderRef { id: string; name: string; webViewLink: string | null; created?: boolean }
export interface DriveFileRef {
  id: string; name: string; mimeType: string; bytes: number | null; modifiedTime: string | null;
  webViewLink: string | null; iconLink: string | null; thumbnailLink: string | null; isFolder: boolean;
}

async function relay<T>(path: string, init: { method: "GET" | "POST"; body?: unknown }, timeoutMs = 30_000): Promise<T> {
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

export function driveFolderUrl(id: string | null | undefined): string | null {
  return id ? `https://drive.google.com/drive/folders/${id}` : null;
}

/** A client deserves a folder once it is bound to an ad platform. */
export function clientQualifiesForFolder(d: { metaAccountId: string | null; googleCustomerId: string | null }): boolean {
  return !!(d.metaAccountId || d.googleCustomerId);
}

/**
 * The client's folder, created on the first call and remembered on the
 * Dashboard row. A folder that was deleted in Drive is recreated. Returns
 * null when the client has no ad account yet (no folder for an empty client).
 */
export async function ensureClientFolder(dashboardId: string, opts: { force?: boolean } = {}): Promise<DriveFolderRef | null> {
  const d = await prisma.dashboard.findUnique({ where: { id: dashboardId }, select: { id: true, name: true, metaAccountId: true, googleCustomerId: true, driveFolderId: true } });
  if (!d) return null;
  if (!opts.force && !clientQualifiesForFolder(d)) return null;
  if (d.driveFolderId) {
    try {
      const f = await relay<DriveFolderRef>(`/api/drive/folder?id=${encodeURIComponent(d.driveFolderId)}`, { method: "GET" }, 15_000);
      return f;
    } catch (e) {
      // Gone from Drive (or trashed): make a new one below. Other failures are reported.
      if (!/introuvable|404/.test(e instanceof Error ? e.message : "")) throw e;
    }
  }
  const ids = [d.metaAccountId ? `Meta act_${d.metaAccountId}` : null, d.googleCustomerId ? `Google Ads ${d.googleCustomerId}` : null].filter(Boolean).join(" · ");
  const folder = await relay<DriveFolderRef & { rootId: string }>("/api/drive/client-folder", {
    method: "POST",
    body: { name: d.name, description: `Client ImpulseMotion « ${d.name} »${ids ? ` — ${ids}` : ""}. Dossier créé par ImpulseMotion.` },
  }, 45_000);
  await prisma.dashboard.update({ where: { id: d.id }, data: { driveFolderId: folder.id } });
  return folder;
}

export async function listClientFiles(folderId: string, limit = 100): Promise<DriveFileRef[]> {
  const out = await relay<{ files: DriveFileRef[] }>(`/api/drive/list?folderId=${encodeURIComponent(folderId)}&limit=${limit}`, { method: "GET" }, 20_000);
  return out.files;
}

export async function ensureSubfolder(parentId: string, name: string, description = ""): Promise<DriveFolderRef> {
  return relay<DriveFolderRef>("/api/drive/folder", { method: "POST", body: { parentId, name, description } }, 30_000);
}

export async function uploadToFolder(folderId: string, file: { name: string; mimeType: string; data: Buffer }): Promise<{ id: string; name: string; webViewLink: string | null; bytes: number; replaced: boolean }> {
  return relay("/api/drive/upload", { method: "POST", body: { folderId, name: file.name, mimeType: file.mimeType, data: file.data.toString("base64") } }, 120_000);
}

/**
 * Standard sub-folders of a client's Drive folder — everything the agency
 * produces for a client lives under ONE folder: « Dashboards » (files the
 * dashboards read), « Créas » (FigCraft and PhotoCraft exports, Mo's visuals),
 * « Briefs » (PDF / Word dropped in Mo), the root for the rest. Created on demand.
 */
export const CLIENT_SUBFOLDERS = {
  dashboards: { name: "Dashboards", description: "Fichiers des dashboards du client (CSV, Excel, Google Sheets lus par le copilote). Dossier ImpulseMotion." },
  creas: { name: "Créas", description: "Créas du client : exports FigCraft (mise en page) et PhotoCraft (retouche), visuels générés ou déposés dans Mo. Dossier ImpulseMotion." },
  briefs: { name: "Briefs", description: "Briefs du client (PDF, Word) déposés par les consultants dans Mo. Dossier ImpulseMotion." },
} as const;

export async function ensureClientSubfolder(dashboardId: string, kind: keyof typeof CLIENT_SUBFOLDERS): Promise<DriveFolderRef | null> {
  const client = await ensureClientFolder(dashboardId, { force: true });
  if (!client) return null;
  const spec = CLIENT_SUBFOLDERS[kind];
  return ensureSubfolder(client.id, spec.name, spec.description);
}
