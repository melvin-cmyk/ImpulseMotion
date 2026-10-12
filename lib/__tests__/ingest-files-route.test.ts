/**
 * POST/GET /api/ingest/files — fichiers de données des bots clients chargés par n8n.
 * Le client est déduit du dossier Drive, jamais du corps ; secret partagé en en-tête.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Bot = { clientKey: string; driveFolderId: string | null; sourcesJson: string };
const bots: Bot[] = [];
const parts: unknown[] = [];
const errors: unknown[] = [];
let known: Record<string, Record<string, string>> = {};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientBot: {
      findMany: async () => bots.filter((b) => b.driveFolderId),
      findUnique: async ({ where }: { where: { driveFolderId: string } }) => bots.find((b) => b.driveFolderId === where.driveFolderId) ?? null,
    },
  },
}));
vi.mock("@/lib/client-datasets", async (original) => {
  const real = await original<typeof import("@/lib/client-datasets")>();
  return {
    ...real,
    knownFilesByClient: async () => known,
    writeDatasetPart: async (part: unknown) => { parts.push(part); return { rowsWritten: 1, finalized: false }; },
    recordDatasetError: async (...args: unknown[]) => { errors.push(args); },
  };
});

import { GET, POST } from "@/app/api/ingest/files/route";

const FOLDER = "1yNzDz0Rbo_OMzBrFDnG_pamoMq9J_zuu";
const url = "http://localhost/api/ingest/files";

function post(body: unknown, secret: string | null = "s3cret") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-files-secret"] = secret;
  return POST(new NextRequest(url, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
}
function get(secret: string | null = "s3cret") {
  const headers: Record<string, string> = {};
  if (secret) headers["x-files-secret"] = secret;
  return GET(new NextRequest(url, { headers }));
}

const validPart = {
  folderId: FOLDER,
  file: { id: "1abcDEFghij_KLMN", name: "Ventes Magasins.csv", mimeType: "text/csv", modifiedTime: "2026-10-12T12:00:00Z" },
  loadId: "load-abc123",
  rowOffset: 0,
  columns: ["Magasin", "CA"],
  rows: [{ Magasin: "Lyon", CA: "12" }],
  final: true,
};

beforeEach(() => {
  process.env.BOT_FILES_SECRET = "s3cret";
  bots.length = 0;
  parts.length = 0;
  errors.length = 0;
  known = {};
  bots.push({ clientKey: "dt", driveFolderId: FOLDER, sourcesJson: JSON.stringify({ files: true }) });
  bots.push({ clientKey: "lpev", driveFolderId: "2abcdefghijklmnop", sourcesJson: JSON.stringify({ data: true }) });
  bots.push({ clientKey: "nofolder", driveFolderId: null, sourcesJson: JSON.stringify({ files: true }) });
});

describe("secret", () => {
  it("refuse sans secret, avec un mauvais secret, ou quand le secret serveur est absent", async () => {
    expect((await get(null)).status).toBe(401);
    expect((await get("nope")).status).toBe(401);
    expect((await post(validPart, "nope")).status).toBe(401);
    process.env.BOT_FILES_SECRET = "";
    expect((await post(validPart, "")).status).toBe(401);
    expect(parts).toHaveLength(0);
  });
});

describe("GET", () => {
  it("liste les dossiers des bots dont la source fichiers est cochée, avec les fichiers déjà chargés", async () => {
    known = { dt: { f1: "2026-10-01T00:00:00Z" } };
    const res = await get();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.folders).toEqual([{ folderId: FOLDER, clientKey: "dt", files: { f1: "2026-10-01T00:00:00Z" } }]);
    expect(json.maxRowsPerPart).toBe(2000);
  });
});

describe("POST", () => {
  it("écrit un lot pour le client du dossier (clé de jeu depuis le nom de fichier)", async () => {
    const res = await post(validPart);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, dataset: "ventes-magasins", rowsWritten: 1 });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      clientKey: "dt", datasetKey: "ventes-magasins", name: "Ventes Magasins", loadId: "load-abc123", rowOffset: 0, final: true,
      source: { driveFileId: "1abcDEFghij_KLMN", fileName: "Ventes Magasins.csv", folderId: FOLDER, modifiedTime: "2026-10-12T12:00:00Z" },
    });
  });

  it("ignore un clientKey glissé dans le corps : seul le dossier compte", async () => {
    const res = await post({ ...validPart, clientKey: "lpev" });
    expect(res.status).toBe(200);
    expect((parts[0] as { clientKey: string }).clientKey).toBe("dt");
  });

  it("refuse un dossier inconnu (404) et un client dont la source fichiers est décochée (409)", async () => {
    expect((await post({ ...validPart, folderId: "3zzzzzzzzzzzzzzzz" })).status).toBe(404);
    expect((await post({ ...validPart, folderId: "2abcdefghijklmnop" })).status).toBe(409);
    expect(parts).toHaveLength(0);
  });

  it("valide le corps : JSON, file, loadId, colonnes, lignes, plafonds", async () => {
    expect((await post("{pas du json")).status).toBe(400);
    expect((await post({ ...validPart, file: { id: "x" } })).status).toBe(400);
    expect((await post({ ...validPart, loadId: "" })).status).toBe(400);
    expect((await post({ ...validPart, columns: [] })).status).toBe(400);
    expect((await post({ ...validPart, rows: [1, 2] })).status).toBe(400);
    expect((await post({ ...validPart, rows: Array.from({ length: 2001 }, () => ({ a: 1 })) })).status).toBe(413);
    expect((await post({ ...validPart, columns: Array.from({ length: 61 }, (_, i) => `c${i}`) })).status).toBe(413);
    expect((await post({ ...validPart, rowOffset: -1 })).status).toBe(400);
    expect(parts).toHaveLength(0);
  });

  it("consigne une erreur de lecture signalée par n8n", async () => {
    const res = await post({ folderId: FOLDER, file: validPart.file, error: "Fichier illisible : feuille vide" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: "error", dataset: "ventes-magasins" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(["dt", "ventes-magasins", "Ventes Magasins", expect.objectContaining({ driveFileId: "1abcDEFghij_KLMN" }), "Fichier illisible : feuille vide"]);
  });
});
