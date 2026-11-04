/**
 * /api/bot/[botId]/datasets — fichiers de données importés par le client
 * depuis le chat de son bot (CSV / Excel lus dans le navigateur).
 *
 * Même entrepôt que les fichiers du dossier Drive (client_data.datasets, voir
 * lib/client-datasets.ts) : le bot les interroge avec les mêmes outils. Le
 * client_key vient toujours du bot (loadBotFor : accès accordé au client, ou
 * staff dans son périmètre), jamais du corps. Ouvert seulement si la source
 * « Fichiers de données » est cochée sur la fiche du bot.
 *
 *   GET    → { datasets: [{ datasetKey, name, rowCount, columns, loadedAt, uploaded }] }
 *   POST   { fileName, mimeType?, loadId, rowOffset, columns, rows, final }
 *          un lot (≤ 2000 lignes) ; `final: true` rend le fichier visible au bot
 *          et remplace un import précédent du même nom.
 *   DELETE { datasetKey } → retire un fichier importé depuis le chat (les
 *          fichiers du dossier Drive restent gérés par l'équipe).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";
import { parseSources } from "@/lib/bot-types";
import { hasClientDataDb } from "@/lib/client-data";
import { resetBotContextMemos } from "@/lib/bot-context";
import {
  MAX_COLUMNS,
  MAX_ROWS_PER_DATASET,
  MAX_ROWS_PER_PART,
  datasetKeyFromFileName,
  datasetNameFromFileName,
  deleteDataset,
  listDatasets,
  writeDatasetPart,
  type DatasetSource,
} from "@/lib/client-datasets";

export const maxDuration = 60;
export const runtime = "nodejs";

type Ctx = { params: Promise<{ botId: string }> };

const LOAD_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const FILE_RE = /\.(csv|tsv|txt|xlsx|xlsm|xls|ods)$/i;

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** The bot, if the session may use it and file data is open on it. */
type Upload =
  | { ok: false; res: NextResponse }
  | { ok: true; bot: { clientKey: string }; email: string | undefined };

async function botForUpload(ctx: Ctx): Promise<Upload> {
  const guard = await requireSession();
  if ("error" in guard) return { ok: false, res: guard.error ?? bad("unauthorized", 401) };
  const { botId } = await ctx.params;
  const loaded = await loadBotFor(guard.session, botId);
  if (loaded.status !== 200) return { ok: false, res: bad(loaded.status === 404 ? "assistant introuvable" : "accès refusé", loaded.status) };
  if (!parseSources(loaded.bot.sourcesJson).files) return { ok: false, res: bad("l'import de fichiers n'est pas activé pour cet assistant", 409) };
  if (!hasClientDataDb()) return { ok: false, res: bad("entrepôt non configuré", 503) };
  return { ok: true, bot: loaded.bot, email: guard.session.user?.email ?? undefined };
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const r = await botForUpload(ctx);
  if (!r.ok) return r.res;
  try {
    const all = await listDatasets(r.bot.clientKey);
    return NextResponse.json({
      datasets: all
        .filter((d) => d.rowCount > 0)
        .map((d) => ({
          datasetKey: d.datasetKey,
          name: d.name,
          rowCount: d.rowCount,
          columns: d.columns.map((c) => c.name),
          loadedAt: d.loadedAt,
          uploaded: d.source.uploadedVia === "chat",
        })),
    });
  } catch (err) {
    console.error("[bot/datasets]", err instanceof Error ? err.message : String(err));
    return bad("entrepôt injoignable", 503);
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const r = await botForUpload(ctx);
  if (!r.ok) return r.res;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("JSON invalide");
  }
  if (!body || typeof body !== "object") return bad("corps invalide");

  const fileName = typeof body.fileName === "string" ? body.fileName.trim().slice(0, 200) : "";
  if (!fileName || !FILE_RE.test(fileName)) return bad("fichier CSV ou Excel attendu");
  const datasetKey = datasetKeyFromFileName(fileName);
  if (!KEY_RE.test(datasetKey)) return bad("nom de fichier invalide");
  const loadId = typeof body.loadId === "string" ? body.loadId.trim() : "";
  if (!LOAD_ID_RE.test(loadId)) return bad("loadId requis");
  const rowOffset = Number(body.rowOffset ?? 0);
  if (!Number.isInteger(rowOffset) || rowOffset < 0 || rowOffset > MAX_ROWS_PER_DATASET) return bad("rowOffset invalide");
  const columns = Array.isArray(body.columns) ? body.columns.filter((c): c is string => typeof c === "string") : [];
  if (!columns.length) return bad("la première ligne doit contenir les en-têtes de colonnes");
  if (columns.length > MAX_COLUMNS) return bad(`${MAX_COLUMNS} colonnes au maximum`, 413);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > MAX_ROWS_PER_PART) return bad(`max ${MAX_ROWS_PER_PART} lignes par envoi`, 413);
  if (rowOffset + rows.length > MAX_ROWS_PER_DATASET) return bad(`${MAX_ROWS_PER_DATASET.toLocaleString("fr-FR")} lignes au maximum par fichier`, 413);
  if (!rows.every((x) => x && typeof x === "object" && !Array.isArray(x))) return bad("rows[] : objets attendus");
  const final = body.final === true;

  try {
    // A Drive file of the same name belongs to the team: an import never replaces it.
    if (rowOffset === 0) {
      const existing = (await listDatasets(r.bot.clientKey)).find((d) => d.datasetKey === datasetKey);
      if (existing && existing.source.uploadedVia !== "chat") {
        return bad("un fichier du même nom est déjà fourni par votre équipe : renommez votre fichier avant de l'importer", 409);
      }
    }
    const source: DatasetSource = {
      fileName,
      mimeType: typeof body.mimeType === "string" ? body.mimeType.slice(0, 120) : undefined,
      uploadedVia: "chat",
      uploadedBy: r.email,
      uploadedAt: new Date().toISOString(),
    };
    const result = await writeDatasetPart({
      clientKey: r.bot.clientKey,
      datasetKey,
      name: datasetNameFromFileName(fileName),
      source,
      loadId,
      rowOffset,
      columns,
      rows: rows as Record<string, unknown>[],
      final,
    });
    if (result.finalized) resetBotContextMemos(r.bot.clientKey);
    return NextResponse.json({ ok: true, dataset: datasetKey, ...result });
  } catch (err) {
    console.error("[bot/datasets]", err);
    return bad("échec de l'enregistrement", 500);
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const r = await botForUpload(ctx);
  if (!r.ok) return r.res;
  const body = (await req.json().catch(() => ({}))) as { datasetKey?: unknown };
  const datasetKey = typeof body.datasetKey === "string" ? body.datasetKey : "";
  if (!KEY_RE.test(datasetKey)) return bad("datasetKey requis");
  try {
    const existing = (await listDatasets(r.bot.clientKey)).find((d) => d.datasetKey === datasetKey);
    if (!existing) return bad("fichier introuvable", 404);
    if (existing.source.uploadedVia !== "chat") return bad("ce fichier est fourni par votre équipe et ne peut pas être retiré ici", 403);
    await deleteDataset(r.bot.clientKey, datasetKey);
    resetBotContextMemos(r.bot.clientKey);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[bot/datasets]", err instanceof Error ? err.message : String(err));
    return bad("entrepôt injoignable", 503);
  }
}
