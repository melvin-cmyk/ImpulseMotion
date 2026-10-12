/**
 * /api/ingest/files — fichiers de données des bots clients, chargés par n8n
 * (flux « ImpulseMotion — Bots clients : fichiers de données (Drive) »).
 *
 * Pas de session : header `X-Files-Secret` = env BOT_FILES_SECRET (un secret
 * pour le flux, comme les webhooks d'alertes). Le client est toujours déduit du
 * dossier Drive (ClientBot.driveFolderId), jamais du corps de la requête.
 *
 *   GET  → dossiers à surveiller + fichiers déjà chargés :
 *          { folders: [{ folderId, clientKey, files: { <driveFileId>: <modifiedTime> } }] }
 *          n8n ne télécharge que les fichiers absents ou plus récents.
 *
 *   POST → un lot de lignes d'un fichier :
 *          { folderId, file: { id, name, mimeType?, modifiedTime }, loadId,
 *            rowOffset, columns: string[], rows: object[], final: boolean }
 *          (≤ 2000 lignes par appel ; `final: true` sur le dernier lot rend le
 *          chargement visible et remplace la version précédente du fichier).
 *          Ou une erreur de lecture : { folderId, file, error: "…" }.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { parseSources } from "@/lib/bot-types";
import {
  MAX_COLUMNS,
  MAX_ROWS_PER_DATASET,
  MAX_ROWS_PER_PART,
  datasetKeyFromFileName,
  datasetNameFromFileName,
  knownFilesByClient,
  recordDatasetError,
  writeDatasetPart,
  type DatasetSource,
} from "@/lib/client-datasets";

export const maxDuration = 60;
export const runtime = "nodejs";

function authorized(req: NextRequest): boolean {
  const want = process.env.BOT_FILES_SECRET?.trim() ?? "";
  const got = req.headers.get("x-files-secret")?.trim() ?? "";
  if (!want || !got) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

const FOLDER_RE = /^[A-Za-z0-9_-]{10,128}$/;
const FILE_ID_RE = /^[A-Za-z0-9_-]{10,128}$/;
const LOAD_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

export async function GET(req: NextRequest) {
  if (!authorized(req)) return unauthorized();
  const bots = await prisma.clientBot.findMany({
    where: { driveFolderId: { not: null } },
    select: { clientKey: true, driveFolderId: true, sourcesJson: true },
    orderBy: { clientKey: "asc" },
  });
  const watched = bots.filter((b) => b.driveFolderId && parseSources(b.sourcesJson).files);
  let known: Record<string, Record<string, string>> = {};
  try {
    known = await knownFilesByClient(watched.map((b) => b.clientKey));
  } catch (err) {
    console.error("[ingest/files] entrepôt injoignable :", err instanceof Error ? err.message : String(err));
    return bad("entrepôt injoignable", 503);
  }
  return NextResponse.json({
    folders: watched.map((b) => ({ folderId: b.driveFolderId, clientKey: b.clientKey, files: known[b.clientKey] ?? {} })),
    maxRowsPerPart: MAX_ROWS_PER_PART,
  });
}

type FileRef = { id: string; name: string; mimeType?: string; modifiedTime?: string };

function readFile(raw: unknown): FileRef | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.id !== "string" || !FILE_ID_RE.test(f.id)) return null;
  if (typeof f.name !== "string" || !f.name.trim()) return null;
  return {
    id: f.id,
    name: f.name.trim().slice(0, 200),
    mimeType: typeof f.mimeType === "string" ? f.mimeType.slice(0, 120) : undefined,
    modifiedTime: typeof f.modifiedTime === "string" ? f.modifiedTime.slice(0, 40) : undefined,
  };
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("JSON invalide");
  }
  if (!body || typeof body !== "object") return bad("corps invalide");

  const folderId = typeof body.folderId === "string" ? body.folderId.trim() : "";
  if (!FOLDER_RE.test(folderId)) return bad("folderId requis");
  const file = readFile(body.file);
  if (!file) return bad("file { id, name } requis");

  const bot = await prisma.clientBot.findUnique({ where: { driveFolderId: folderId }, select: { clientKey: true, sourcesJson: true } });
  if (!bot) return bad("dossier inconnu", 404);
  if (!parseSources(bot.sourcesJson).files) return bad("source « fichiers » désactivée pour ce client", 409);

  const datasetKey = datasetKeyFromFileName(file.name);
  const name = datasetNameFromFileName(file.name);
  const source: DatasetSource = { driveFileId: file.id, fileName: file.name, mimeType: file.mimeType, modifiedTime: file.modifiedTime, folderId };

  // A read error reported by n8n: keep it visible on the admin page.
  if (typeof body.error === "string") {
    try {
      await recordDatasetError(bot.clientKey, datasetKey, name, source, body.error);
    } catch (err) {
      console.error("[ingest/files] erreur non consignée :", err instanceof Error ? err.message : String(err));
      return bad("entrepôt injoignable", 503);
    }
    return NextResponse.json({ ok: true, recorded: "error", dataset: datasetKey });
  }

  const loadId = typeof body.loadId === "string" ? body.loadId.trim() : "";
  if (!LOAD_ID_RE.test(loadId)) return bad("loadId requis");
  const rowOffset = Number(body.rowOffset ?? 0);
  if (!Number.isInteger(rowOffset) || rowOffset < 0 || rowOffset > MAX_ROWS_PER_DATASET) return bad("rowOffset invalide");
  const columns = Array.isArray(body.columns) ? body.columns.filter((c): c is string => typeof c === "string") : [];
  if (!columns.length) return bad("columns[] requis (en-têtes du fichier)");
  if (columns.length > MAX_COLUMNS) return bad(`max ${MAX_COLUMNS} colonnes`, 413);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > MAX_ROWS_PER_PART) return bad(`max ${MAX_ROWS_PER_PART} lignes par appel`, 413);
  if (rowOffset + rows.length > MAX_ROWS_PER_DATASET) return bad(`max ${MAX_ROWS_PER_DATASET} lignes par fichier`, 413);
  if (!rows.every((r) => r && typeof r === "object" && !Array.isArray(r))) return bad("rows[] : objets attendus");
  const final = body.final === true;

  try {
    const result = await writeDatasetPart({
      clientKey: bot.clientKey,
      datasetKey,
      name,
      source,
      loadId,
      rowOffset,
      columns,
      rows: rows as Record<string, unknown>[],
      final,
    });
    return NextResponse.json({ ok: true, dataset: datasetKey, ...result });
  } catch (err) {
    console.error("[ingest/files]", err);
    return bad("échec de l'écriture", 500);
  }
}
