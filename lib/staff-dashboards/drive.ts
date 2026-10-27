/**
 * Dossier Google Drive de dépôt des fichiers pour les dashboards du staff
 * (CSV, Excel, Google Sheets), appartenant à data@impulse-analytics.com et
 * ouvert en écriture à tout le domaine. Son identifiant vient de
 * NEXT_PUBLIC_STAFF_DASHBOARDS_DRIVE_FOLDER (Vercel) : lisible par le
 * navigateur (lien dans l'interface) et par le serveur (prompt du copilote).
 * Absent → pas de lien, pas de consigne.
 */

export const STAFF_DASHBOARDS_DRIVE_FOLDER_ID: string | null =
  (process.env.NEXT_PUBLIC_STAFF_DASHBOARDS_DRIVE_FOLDER || "").trim() || null;

export const STAFF_DASHBOARDS_DRIVE_FOLDER_URL: string | null = STAFF_DASHBOARDS_DRIVE_FOLDER_ID
  ? `https://drive.google.com/drive/folders/${STAFF_DASHBOARDS_DRIVE_FOLDER_ID}`
  : null;

/**
 * The client's own Drive folder for a staff dashboard: the dashboard's sources
 * name ad accounts → the client registry says which client they belong to →
 * « ImpulseMotion – Clients/<Client>/Dashboards » (created on demand through
 * the relay). Null when the sources name no known client: the shared folder
 * above remains the fallback.
 */
export interface StaffDashboardDriveFolder { id: string; url: string; clientName: string }

export async function staffDashboardClientFolder(sourcesJson: string | null | undefined, opts: { timeoutMs?: number } = {}): Promise<StaffDashboardDriveFolder | null> {
  const { parseSources } = await import("./sources");
  const { listClientRegistry } = await import("@/lib/clients/registry");
  const { ensureClientSubfolder, driveFolderUrl } = await import("@/lib/clients/drive");
  const ids = new Set(parseSources(sourcesJson ?? "[]").flatMap((s) => s.accounts.map((a) => a.id.replace(/^act_/, "").replace(/-/g, ""))));
  if (!ids.size) return null;
  const clients = await listClientRegistry({ all: true });
  const client = clients.find((c) => c.dashboardId && c.accounts.some((a) => ids.has(a.id)));
  if (!client?.dashboardId) return null;
  const work = ensureClientSubfolder(client.dashboardId, "dashboards");
  const folder = opts.timeoutMs
    ? await Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.timeoutMs))])
    : await work;
  if (!folder) return null;
  return { id: folder.id, url: folder.webViewLink ?? driveFolderUrl(folder.id) ?? `https://drive.google.com/drive/folders/${folder.id}`, clientName: client.name };
}
