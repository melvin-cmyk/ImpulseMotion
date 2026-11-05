/**
 * /api/bot/[botId]/datasets — import de fichiers par le client depuis le chat.
 * client_key toujours celui du bot accessible ; source « fichiers » requise ;
 * un import ne remplace ni ne retire jamais un fichier du dossier Drive.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { DatasetSummary } from "@/lib/client-datasets";
import { decodeText, rowsFromMatrix, splitParts } from "@/lib/dataset-file-reader";

let session: { userId: string; user?: { email?: string } } | null = { userId: "u1", user: { email: "client@x.fr" } };
let loaded: { status: number; bot: { clientKey: string; sourcesJson: string } | null } = { status: 200, bot: { clientKey: "dt", sourcesJson: JSON.stringify({ files: true }) } };
let datasets: DatasetSummary[] = [];
const parts: Array<Record<string, unknown>> = [];
const deleted: string[] = [];
const resets: string[] = [];

vi.mock("@/lib/auth-helpers", () => ({
  requireSession: async () => (session ? { session } : { error: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }) }),
}));
vi.mock("@/lib/bot-access", () => ({ loadBotFor: async () => loaded }));
vi.mock("@/lib/client-data", () => ({ hasClientDataDb: () => true }));
vi.mock("@/lib/bot-context", () => ({ resetBotContextMemos: (k: string) => { resets.push(k); } }));
vi.mock("@/lib/client-datasets", async (original) => {
  const real = await original<typeof import("@/lib/client-datasets")>();
  return {
    ...real,
    listDatasets: async () => datasets,
    writeDatasetPart: async (p: Record<string, unknown>) => { parts.push(p); return p.final ? { rowsWritten: 1, finalized: true, rowCount: 1 } : { rowsWritten: 1, finalized: false }; },
    deleteDataset: async (_c: string, k: string) => { deleted.push(k); return true; },
  };
});

import { DELETE, GET, POST } from "@/app/api/bot/[botId]/datasets/route";

const ctx = { params: Promise.resolve({ botId: "b1" }) };
const url = "http://localhost/api/bot/b1/datasets";
const post = (body: unknown) => POST(new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx);
const del = (body: unknown) => DELETE(new NextRequest(url, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx);
const part = { fileName: "Ventes 2025.xlsx", loadId: "chat-abc123", rowOffset: 0, columns: ["Mois", "CA"], rows: [{ Mois: "2025-01", CA: 12 }], final: true };

function ds(key: string, uploadedVia?: "chat"): DatasetSummary {
  return { clientKey: "dt", datasetKey: key, name: key, description: null, columns: [{ name: "a", type: "text" }], rowCount: 3, source: uploadedVia ? { uploadedVia } : { driveFileId: "1abcdefghijk" }, lastError: null, loadedAt: null, updatedAt: null };
}

beforeEach(() => {
  session = { userId: "u1", user: { email: "client@x.fr" } };
  loaded = { status: 200, bot: { clientKey: "dt", sourcesJson: JSON.stringify({ files: true }) } };
  datasets = [];
  parts.length = 0;
  deleted.length = 0;
  resets.length = 0;
});

describe("accès", () => {
  it("refuse sans session, hors accès, ou quand la source fichiers est fermée", async () => {
    session = null;
    expect((await post(part)).status).toBe(401);
    session = { userId: "u1" };
    loaded = { status: 403, bot: null };
    expect((await post(part)).status).toBe(403);
    loaded = { status: 200, bot: { clientKey: "dt", sourcesJson: JSON.stringify({ meta: true }) } };
    expect((await post(part)).status).toBe(409);
    expect(parts).toHaveLength(0);
  });
});

describe("POST", () => {
  it("écrit dans le client du bot, marque l'import « chat » et vide le cache du bot", async () => {
    const res = await post({ ...part, clientKey: "autre" });
    expect(res.status).toBe(200);
    expect(parts[0]).toMatchObject({ clientKey: "dt", datasetKey: "ventes-2025", source: { uploadedVia: "chat", uploadedBy: "client@x.fr", fileName: "Ventes 2025.xlsx" } });
    expect(resets).toEqual(["dt"]);
  });

  it("refuse un format inconnu, sans en-têtes, ou trop de lignes", async () => {
    expect((await post({ ...part, fileName: "rapport.pdf" })).status).toBe(400);
    expect((await post({ ...part, columns: [] })).status).toBe(400);
    expect((await post({ ...part, rows: Array.from({ length: 2001 }, () => ({ a: 1 })) })).status).toBe(413);
  });

  it("ne remplace pas un fichier du même nom venu du dossier Drive", async () => {
    datasets = [ds("ventes-2025")];
    expect((await post(part)).status).toBe(409);
    datasets = [ds("ventes-2025", "chat")];
    expect((await post(part)).status).toBe(200);
  });
});

describe("GET / DELETE", () => {
  it("ne liste que les fichiers importés par le client et ne retire que ceux-là", async () => {
    datasets = [ds("drive-file"), ds("mon-import", "chat")];
    const j = await (await GET(new NextRequest(url), ctx)).json();
    expect(j.datasets.map((d: { datasetKey: string; uploaded: boolean }) => [d.datasetKey, d.uploaded])).toEqual([["mon-import", true]]);
    expect((await del({ datasetKey: "drive-file" })).status).toBe(403);
    expect((await del({ datasetKey: "mon-import" })).status).toBe(200);
    expect(deleted).toEqual(["mon-import"]);
  });
});

describe("lecteur de fichiers", () => {
  it("en-têtes = 1re ligne non vide, colonnes uniques, lignes vides ignorées, dates ISO", () => {
    const r = rowsFromMatrix([[null, null], ["Mois", "CA", "CA", null], [new Date("2025-01-01T00:00:00Z"), 10, 11, null], [null, null, null, null], ["2025-02", 12, null, null]]);
    expect(r.columns).toEqual(["Mois", "CA", "CA_2"]);
    expect(r.rows).toEqual([{ Mois: "2025-01-01", CA: 10, CA_2: 11 }, { Mois: "2025-02", CA: 12, CA_2: null }]);
  });

  it("découpe par nombre de lignes et par taille", () => {
    expect(splitParts(Array.from({ length: 4500 }, (_, i) => ({ i })), 2000).map((p) => p.length)).toEqual([2000, 2000, 500]);
    expect(splitParts([{ a: "x".repeat(60) }, { a: "y".repeat(60) }], 2000, 100).length).toBe(2);
    expect(splitParts([])).toEqual([[]]);
  });

  it("lit un CSV en UTF-8 (BOM retiré) ou en Windows-1252", () => {
    expect(decodeText(new TextEncoder().encode("\uFEFFÉté;1").buffer as ArrayBuffer)).toBe("Été;1");
    expect(decodeText(new Uint8Array([0xc9, 0x74, 0xe9]).buffer)).toBe("Été");
  });
});
