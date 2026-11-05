/**
 * POST /api/bot/[botId]/sheet { title, columns, rows } → { url, notified }
 *
 * A table of an assistant reply opened as a Google Sheet: created by the
 * agency's data@ account in the client's Drive folder (« Tableaux »), then
 * shared with the person who asked (writer). Only for who may use this bot
 * (loadBotFor); the cells are the text the chat showed (lib/bot-sheet.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession, isStaff } from "@/lib/auth-helpers";
import { loadBotFor } from "@/lib/bot-access";
import { createSheetFromRows, ensureClientSubfolder, shareFile } from "@/lib/clients/drive";
import { sheetName, toSheetTable } from "@/lib/bot-sheet";

export const maxDuration = 60;

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest, { params }: { params: Promise<{ botId: string }> }) {
  const guard = await requireSession();
  if ("error" in guard) return guard.error ?? bad("unauthorized", 401);
  const { botId } = await params;
  const loaded = await loadBotFor(guard.session, botId);
  if (loaded.status !== 200) return bad(loaded.status === 404 ? "assistant introuvable" : "accès refusé", loaded.status);

  const body = (await req.json().catch(() => null)) as { title?: unknown; columns?: unknown; rows?: unknown } | null;
  const table = body ? toSheetTable(body) : null;
  if (!table) return bad("tableau invalide (2 000 lignes et 30 colonnes au maximum)");
  const title = typeof body?.title === "string" ? body.title : "";

  try {
    const folder = await ensureClientSubfolder(loaded.bot.dashboard.id, "tables");
    if (!folder) return bad("dossier Drive du client introuvable", 404);
    const sheet = await createSheetFromRows(folder.id, sheetName(title || loaded.bot.dashboard.name), table.columns, table.rows);
    const email = guard.session.user?.email ?? "";
    // The team reaches the client folders through the domain share; a client gets this file only.
    let notified = false;
    if (!isStaff(guard.session) && email) {
      notified = (await shareFile(sheet.id, email, { role: "writer", message: "Tableau exporté depuis votre assistant ImpulseMotion." })).notified;
    }
    const url = sheet.webViewLink ?? `https://docs.google.com/spreadsheets/d/${sheet.id}/edit`;
    return NextResponse.json({ url, notified });
  } catch (err) {
    console.error("[bot/sheet]", err instanceof Error ? err.message : String(err));
    return bad("Création de la feuille impossible pour le moment, réessayez.", 502);
  }
}
