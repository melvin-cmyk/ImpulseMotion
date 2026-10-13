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
