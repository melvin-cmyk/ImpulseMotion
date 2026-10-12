-- Dossier Google Drive du client (fichiers de données lus par n8n → /api/ingest/files)
ALTER TABLE "ClientBot" ADD COLUMN "driveFolderId" TEXT;
CREATE UNIQUE INDEX "ClientBot_driveFolderId_key" ON "ClientBot"("driveFolderId");
