/**
 * Designs → the client's Google Drive folder.
 *
 * A design attached to a client keeps its deliverables in
 *   <Client>/Créas/<design name>/   (the client folder of lib/clients/drive.ts)
 * - what the consultant exports from the page (PNG, SVG, PDF) goes there;
 * - what the AI exports into the design's workspace (out/) is copied there
 *   when its reply ends (lib/ai-jobs.ts).
 * Best effort everywhere: a Drive failure never fails the design.
 */

import { prisma } from "@/lib/prisma";
import { RELAY_URLS } from "@/lib/relay-server";
import { relayHeaders } from "@/lib/relay-headers";
import { contentTypeFor, workspaceIdFor } from "@/lib/relay-workspace";
import { ensureClientSubfolder, ensureSubfolder, uploadToFolder, type DriveFolderRef } from "@/lib/clients/drive";
import { designSessionKey } from "@/lib/design/model";

const SYNC_EXT_RE = /\.(png|jpe?g|webp|svg|pdf|figcraft|fig|psd|psb|tiff?)$/i;

/** The design's folder in the client's Drive (<Client>/Créas/<name>), created on demand; null without a client. */
export async function designDriveFolder(designId: string): Promise<DriveFolderRef | null> {
  const d = await prisma.designFile.findUnique({ where: { id: designId }, select: { name: true, clientDashboardId: true } });
  if (!d?.clientDashboardId) return null;
  const creas = await ensureClientSubfolder(d.clientDashboardId, "creas");
  if (!creas) return null;
  return ensureSubfolder(creas.id, d.name, "Exports de ce design (ImpulseMotion /design).");
}

/** Puts one exported file in the design's Drive folder. */
export async function uploadDesignExport(designId: string, file: { name: string; mimeType: string; data: Buffer }): Promise<{ webViewLink: string | null } | null> {
  const folder = await designDriveFolder(designId);
  if (!folder) return null;
  const out = await uploadToFolder(folder.id, file);
  return { webViewLink: out.webViewLink };
}

async function relayWorkspaceFiles(ws: string): Promise<Array<{ path: string; bytes: number; mtime?: number }>> {
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/files/${ws}`, { headers: relayHeaders(), signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      return ((await res.json()) as { files?: Array<{ path: string; bytes: number; mtime?: number }> }).files ?? [];
    } catch { /* next url */ }
  }
  return [];
}

async function relayWorkspaceFile(ws: string, rel: string): Promise<Buffer | null> {
  for (const url of RELAY_URLS) {
    try {
      const res = await fetch(`${url}/api/files/${ws}/${encodeURIComponent(rel).replace(/%2F/g, "/")}`, { headers: relayHeaders(), signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      return Buffer.from(await res.arrayBuffer());
    } catch { /* next url */ }
  }
  return null;
}

/**
 * Copies the files the AI exported (out/) since `since` to the design's Drive
 * folder. Same name → the Drive file gets a new version. Returns how many landed.
 */
export async function syncDesignOutputsToDrive(designId: string, since: number | null = null): Promise<number> {
  const folder = await designDriveFolder(designId);
  if (!folder) return 0;
  const ws = workspaceIdFor(designSessionKey(designId));
  const files = (await relayWorkspaceFiles(ws)).filter((f) => f.path.startsWith("out/") && SYNC_EXT_RE.test(f.path) && (!since || !f.mtime || f.mtime >= since));
  let n = 0;
  for (const f of files.slice(0, 40)) {
    const data = await relayWorkspaceFile(ws, f.path);
    if (!data?.length) continue;
    const name = f.path.slice("out/".length);
    try {
      await uploadToFolder(folder.id, { name, mimeType: contentTypeFor(name), data });
      n += 1;
    } catch (e) {
      console.error(`[design-drive] ${designId} ${name} : ${e instanceof Error ? e.message : e}`);
    }
  }
  return n;
}
